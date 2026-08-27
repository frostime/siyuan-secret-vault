import { showMessage, type Protyle } from "siyuan";
import type { SecretRecord } from "../types";
import {
  deleteBlock,
  getBlockAttrs,
  getBlockKramdown,
  insertMarkdownBlock,
  setBlockAttrs,
  type BlockInsertionTarget,
} from "./siyuan-api";

const REFERENCE_VERSION = "2";
const DEFAULT_EMBED_HEIGHT = 178;

export type SecretReferenceSource = Pick<
  SecretRecord,
  "id" | "groupId" | "label" | "createdAt" | "updatedAt"
>;

export interface DormantReferenceDefinition {
  markdown: string;
  attrs: Record<string, string>;
}

export interface SlashTarget {
  insertion: BlockInsertionTarget;
  cleanupBlockId: string | null;
}

/**
 * Owns the persistent SiYuan representation of a Secret reference.
 *
 * Version 2 references are dormant document-owned snapshots. Their iframe loads
 * one non-reactive local shell and does not contact the plugin runtime. The
 * only active transition is the user's explicit link navigation to live.html.
 * Secret ID remains authoritative; all other custom attributes are
 * non-authoritative display metadata.
 */
export class SecretReferenceService {
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

  async insertAtCaret(
    secret: SecretReferenceSource,
    groupName: string,
    protyle: Protyle,
  ): Promise<void> {
    await this.insert(secret, groupName, this.resolveEditorInsertionTarget(protyle), null);
  }

  async insertFromSlash(
    secret: SecretReferenceSource,
    groupName: string,
    slashTarget: SlashTarget,
  ): Promise<void> {
    await this.insert(secret, groupName, slashTarget.insertion, slashTarget.cleanupBlockId);
  }

  /** Builds the complete persistent v2 representation without writing it. */
  buildDormantReference(
    secret: SecretReferenceSource,
    groupName: string,
    existingStyle = "",
  ): DormantReferenceDefinition {
    const dormantSrc = `/plugins/${this.pluginName}/embed/index.html`;
    const title = `Secret Vault: ${secret.label || "Secret"}`;
    const markdown = [
      '<iframe loading="lazy"',
      ` src="${escapeHtmlAttribute(dormantSrc)}"`,
      ` title="${escapeHtmlAttribute(title)}"`,
      ` style="width: 100%; height: 100%; border: 0; border-radius: 6px;"`,
      "></iframe>",
    ].join("");

    return {
      markdown,
      attrs: {
        "custom-secret-vault": "1",
        "custom-secret-id": secret.id,
        "custom-secret-group": secret.groupId,
        "custom-secret-label": secret.label,
        "custom-secret-group-name": groupName,
        "custom-secret-created-at": String(secret.createdAt),
        "custom-secret-updated-at": String(secret.updatedAt),
        "custom-secret-version": REFERENCE_VERSION,
        style: mergeInitialHeight(existingStyle, DEFAULT_EMBED_HEIGHT),
      },
    };
  }

  /**
   * Checks the persisted v2 iframe representation after SiYuan/Lute has parsed it.
   *
   * SiYuan 3.8 sanitizes `srcdoc` on document iframe blocks, so the canonical
   * dormant representation deliberately uses a normal same-origin plugin URL.
   */
  isDormantReferenceMarkdown(markdown: string): boolean {
    const src = extractIframeSrc(markdown);
    if (src === null) return false;

    try {
      const url = new URL(src, location.origin);
      return url.pathname === `/plugins/${this.pluginName}/embed/index.html`
        && !url.searchParams.has("secret");
    } catch {
      return false;
    }
  }

  /** Validates the authoritative reference identity during an explicit session handshake. */
  async matchesReference(blockId: string, secretId: string): Promise<boolean> {
    const attrs = await getBlockAttrs(blockId);
    return attrs["custom-secret-vault"] === "1"
      && attrs["custom-secret-id"] === secretId;
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
    secret: SecretReferenceSource,
    groupName: string,
    target: BlockInsertionTarget,
    cleanupBlockId: string | null,
  ): Promise<void> {
    const initialDefinition = this.buildDormantReference(secret, groupName);
    const inserted = await insertMarkdownBlock(initialDefinition.markdown, target);

    // Standalone <iframe> must become a real NodeIFrame. Fail closed if a
    // future Lute version changes this parse rule.
    if (inserted.dom && !inserted.dom.includes('data-type="NodeIFrame"')) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源没有把嵌入内容解析为 IFrame 块；已回滚此次插入");
    }

    // Validate what SiYuan actually persisted, not only the HTML we generated.
    // This specifically guards against sanitizers silently dropping iframe
    // attributes (the 0.4.0/0.4.1 srcdoc regression).
    const persistedMarkdown = await getBlockKramdown(inserted.id);
    if (!this.isDormantReferenceMarkdown(persistedMarkdown)) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源改写了 Secret 静态引用；已回滚此次插入，请升级插件后重试");
    }

    try {
      const attrs = await getBlockAttrs(inserted.id);
      const definition = this.buildDormantReference(secret, groupName, attrs.style ?? "");
      await setBlockAttrs(inserted.id, definition.attrs);
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

      // The dialog is asynchronous. Re-check persisted content before deleting
      // the slash source so user edits made while the dialog was open survive.
      if (isSlashOnlyText(source)) {
        await deleteBlock(blockId);
      }
    } catch (error) {
      console.warn("[secret-vault] failed to clean slash source block", blockId, error);
    }
  }
}

function extractIframeSrc(markdown: string): string | null {
  const html = markdown.replace(/\n?\{:[\s\S]*$/, "").trim();
  const iframe = html.match(/<iframe\b[^>]*>/i)?.[0] ?? "";
  if (!iframe) return null;

  const match = iframe.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function normalizeEditorText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function isSlashOnlyText(value: string): boolean {
  return /^\/\S*$/.test(value);
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

function mergeInitialHeight(style: string, height: number): string {
  const declaration = `height: ${height}px`;
  const heightPattern = /(^|;)\s*height\s*:[^;]*/gi;

  if (heightPattern.test(style)) {
    heightPattern.lastIndex = 0;
    let replaced = false;
    const merged = style.replace(heightPattern, (_match, separator: string) => {
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
