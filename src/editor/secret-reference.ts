import { showMessage, type Protyle } from "siyuan";
import type { GroupId, SecretId } from "../types";
import {
  deleteBlock,
  getBlockAttrs,
  getBlockKramdown,
  insertMarkdownBlock,
  setBlockAttrs,
  type BlockInsertionTarget,
} from "./siyuan-api";

const INITIAL_EMBED_HEIGHT = 54;
const MIN_EMBED_HEIGHT = 42;
const MAX_EMBED_HEIGHT = 420;
const HEIGHT_WRITE_EPSILON = 4;

interface ResizeState {
  pendingHeight: number | null;
  running: Promise<void> | null;
}

export interface SecretReferenceDescriptor {
  id: SecretId;
  groupId: GroupId;
  label: string;
}

export interface SlashTarget {
  insertion: BlockInsertionTarget;
  cleanupBlockId: string | null;
}

/** Owns the SiYuan block format used to reference one vault secret. */
export class SecretReferenceService {
  private readonly resizeStateByBlock = new Map<string, ResizeState>();

  constructor(private readonly pluginName: string) {}

  captureSlashTarget(protyle: Protyle, nodeElement: HTMLElement): SlashTarget {
    const anchorBlockId = nodeElement.dataset.nodeId || null;
    if (!anchorBlockId) {
      return {
        cleanupBlockId: null,
        insertion: this.resolveEditorInsertionTarget(protyle),
      };
    }

    const editable = nodeElement.querySelector<HTMLElement>('[contenteditable="true"]');
    const text = normalizeEditorText(editable?.textContent ?? nodeElement.textContent ?? "");
    const slashOnly = isSlashOnlyText(text);

    return {
      cleanupBlockId: slashOnly ? anchorBlockId : null,
      insertion: slashOnly
        ? { nextID: anchorBlockId }
        : { previousID: anchorBlockId },
    };
  }

  async insertAtCaret(secret: SecretReferenceDescriptor, protyle: Protyle): Promise<void> {
    await this.insert(secret, this.resolveEditorInsertionTarget(protyle), null);
  }

  async insertFromSlash(
    secret: SecretReferenceDescriptor,
    slashTarget: SlashTarget,
  ): Promise<void> {
    await this.insert(secret, slashTarget.insertion, slashTarget.cleanupBlockId);
  }

  /**
   * Persists an interaction-driven embed height through SiYuan's block
   * attribute API. The plugin never mutates Protyle's NodeIFrame DOM directly.
   *
   * Requests for the same block are coalesced and serialized so quick
   * edit/cancel interactions cannot finish out of order.
   */
  resizeEmbedBlock(blockId: string, requestedHeight: number): Promise<void> {
    const height = clampEmbedHeight(requestedHeight);
    let state = this.resizeStateByBlock.get(blockId);

    if (!state) {
      state = { pendingHeight: null, running: null };
      this.resizeStateByBlock.set(blockId, state);
    }

    state.pendingHeight = height;
    if (!state.running) {
      state.running = this.flushResizeRequests(blockId, state).finally(() => {
        state!.running = null;
        if (state!.pendingHeight === null) this.resizeStateByBlock.delete(blockId);
      });
    }

    return state.running;
  }

  private async flushResizeRequests(blockId: string, state: ResizeState): Promise<void> {
    while (state.pendingHeight !== null) {
      const height = state.pendingHeight;
      state.pendingHeight = null;
      await this.persistEmbedHeight(blockId, height);
    }
  }

  private async persistEmbedHeight(blockId: string, height: number): Promise<void> {
    const attrs = await getBlockAttrs(blockId);
    if (attrs["custom-secret-vault"] !== "1") return;

    const currentStyle = attrs.style ?? "";
    const currentHeight = readPixelHeight(currentStyle);
    if (currentHeight !== null && Math.abs(currentHeight - height) < HEIGHT_WRITE_EPSILON) {
      return;
    }

    await setBlockAttrs(blockId, {
      style: mergeStyleHeight(currentStyle, height),
    });
  }

  private resolveEditorInsertionTarget(protyle: Protyle): BlockInsertionTarget {
    const selection = globalThis.getSelection?.();
    const anchorNode = selection?.anchorNode ?? null;
    const element = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null;
    const selectedBlock = element?.closest<HTMLElement>("[data-node-id]");

    if (selectedBlock?.dataset.nodeId && protyle.wysiwyg.element.contains(selectedBlock)) {
      return { previousID: selectedBlock.dataset.nodeId };
    }
    if (protyle.block?.rootID) return { parentID: protyle.block.rootID };
    throw new Error("无法确定插入位置");
  }

  private async insert(
    secret: SecretReferenceDescriptor,
    target: BlockInsertionTarget,
    cleanupBlockId: string | null,
  ): Promise<void> {
    const src = `/plugins/${this.pluginName}/embed/index.html?secret=${encodeURIComponent(secret.id)}`;
    const iframe = `<iframe src="${src}" style="width: 100%; height: ${INITIAL_EMBED_HEIGHT}px; border: 0; border-radius: 6px;"></iframe>`;

    const inserted = await insertMarkdownBlock(iframe, target);

    // Standalone <iframe> must become a real NodeIFrame. If a future Lute
    // version changes this parse rule, fail closed instead of leaving garbage.
    if (inserted.dom && !inserted.dom.includes('data-type="NodeIFrame"')) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源没有把嵌入内容解析为 IFrame 块；已回滚此次插入");
    }

    try {
      const attrs = await getBlockAttrs(inserted.id);
      await setBlockAttrs(inserted.id, {
        "custom-secret-vault": "1",
        "custom-secret-id": secret.id,
        "custom-secret-group": secret.groupId,
        "custom-secret-version": "1",
        style: mergeStyleHeight(attrs.style ?? "", INITIAL_EMBED_HEIGHT),
      });
    } catch (error) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw error;
    }

    if (cleanupBlockId) await this.cleanupSlashSource(cleanupBlockId);
    showMessage(`已插入秘密：${secret.label}`);
  }

  private async cleanupSlashSource(blockId: string): Promise<void> {
    try {
      const kramdown = await getBlockKramdown(blockId);
      const source = normalizeEditorText(kramdown.replace(/\n?\{:[\s\S]*$/, ""));

      // The dialog is asynchronous. Re-check the persisted block before
      // deleting it so a block changed after the slash command is never lost.
      if (isSlashOnlyText(source)) {
        await deleteBlock(blockId);
      }
    } catch (error) {
      console.warn("[secret-vault] failed to clean slash source block", blockId, error);
    }
  }
}

function normalizeEditorText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function isSlashOnlyText(value: string): boolean {
  return /^\/\S*$/.test(value);
}

function clampEmbedHeight(value: number): number {
  return Math.round(Math.max(MIN_EMBED_HEIGHT, Math.min(MAX_EMBED_HEIGHT, value)));
}

function readPixelHeight(style: string): number | null {
  const match = style.match(/(?:^|;)\s*height\s*:\s*(-?\d+(?:\.\d+)?)px(?:\s*!important)?\s*(?=;|$)/i);
  if (!match) return null;

  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function mergeStyleHeight(style: string, height: number): string {
  const declaration = `height: ${height}px`;
  const heightPattern = /(^|;)\s*height\s*:[^;]*/gi;

  if (heightPattern.test(style)) {
    heightPattern.lastIndex = 0;
    let replaced = false;
    const merged = style.replace(heightPattern, (match, separator: string) => {
      if (replaced) return separator;
      replaced = true;
      return `${separator}${separator ? " " : ""}${declaration}`;
    });
    return ensureTrailingSemicolon(merged);
  }

  const prefix = style.trim();
  return prefix
    ? `${ensureTrailingSemicolon(prefix)} ${declaration};`
    : `${declaration};`;
}

function ensureTrailingSemicolon(style: string): string {
  const trimmed = style.trim();
  return !trimmed || trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}
