import { showMessage, type Protyle } from "siyuan";
import type { GroupId, SecretId } from "../types";
import {
  deleteBlock,
  getBlockKramdown,
  insertMarkdownBlock,
  setBlockAttrs,
  type BlockInsertionTarget,
} from "./siyuan-api";

const INITIAL_EMBED_HEIGHT = 54;

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
      await setBlockAttrs(inserted.id, {
        "custom-secret-vault": "1",
        "custom-secret-id": secret.id,
        "custom-secret-group": secret.groupId,
        "custom-secret-version": "1",
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
