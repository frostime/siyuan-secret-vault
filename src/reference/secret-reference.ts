import { showMessage, type Protyle } from "siyuan";
import type { SecretRecord } from "../types";
import {
  deleteBlock,
  getBlockAttrs,
  getBlockKramdown,
  insertMarkdownBlock,
  setBlockAttrs,
  updateMarkdownBlock,
  type BlockInsertionTarget,
} from "../siyuan/api";

export const SECRET_REFERENCE_VERSION = "4";
const SECRET_PATH_PREFIX = "/secret/";

export type SecretReferenceSource = Pick<
  SecretRecord,
  "id" | "groupId" | "label" | "createdAt" | "updatedAt"
>;

export interface ParagraphReferenceDefinition {
  markdown: string;
  attrs: Record<string, string>;
}

export interface SlashTarget {
  insertion: BlockInsertionTarget;
  cleanupBlockId: string | null;
}

export interface ParsedSecretLink {
  secretId: string;
  url: string;
}

/**
 * Owns every persistent detail of the v4 document reference format.
 *
 * A v4 reference is an ordinary NodeParagraph plus custom-* attributes. The
 * paragraph contains only a plugin deep link and presentation snapshots; it has
 * no per-reference script, iframe, timer, observer, or Vault client.
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
      insertion: slashOnly ? { nextID: anchorBlockId } : { previousID: anchorBlockId },
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

  buildParagraphReference(
    secret: SecretReferenceSource,
    groupName: string,
  ): ParagraphReferenceDefinition {
    const url = this.buildSecretUrl(secret.id);
    return {
      markdown: `🔐 [${escapeMarkdownLinkText(secret.label)}](${url}) · ${escapeMarkdownText(groupName)}`,
      attrs: {
        "custom-secret-vault": "1",
        "custom-secret-version": SECRET_REFERENCE_VERSION,
        "custom-secret-id": secret.id,
        "custom-secret-group": secret.groupId,
        "custom-secret-label": secret.label,
        "custom-secret-group-name": groupName,
        "custom-secret-created-at": String(secret.createdAt),
        "custom-secret-updated-at": String(secret.updatedAt),
      },
    };
  }

  buildSecretUrl(secretId: string): string {
    return `siyuan://plugins/${encodeURIComponent(this.pluginName)}${SECRET_PATH_PREFIX}${encodeURIComponent(secretId)}`;
  }

  parseSecretUrl(value: string | null | undefined): ParsedSecretLink | null {
    if (!value) return null;

    try {
      const url = new URL(value);
      if (url.protocol !== "siyuan:" || url.hostname !== "plugins") return null;

      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments.length !== 3) return null;
      if (segments[0] !== this.pluginName || segments[1] !== "secret") return null;

      const secretId = segments[2]?.trim();
      if (!secretId || !/^sec_[A-Za-z0-9-]+$/.test(secretId)) return null;
      return { secretId, url: value };
    } catch {
      return null;
    }
  }

  /** Checks the persistent authority before granting document interaction. */
  async matchesReference(blockId: string, secretId: string): Promise<boolean> {
    const attrs = await getBlockAttrs(blockId);
    return attrs["custom-secret-vault"] === "1"
      && attrs["custom-secret-version"] === SECRET_REFERENCE_VERSION
      && attrs["custom-secret-id"] === secretId;
  }

  async refreshSnapshot(
    blockId: string,
    secret: SecretReferenceSource,
    groupName: string,
  ): Promise<void> {
    if (!(await this.matchesReference(blockId, secret.id))) {
      throw new Error("文档引用已变化，未覆盖当前块");
    }

    const definition = this.buildParagraphReference(secret, groupName);
    await updateMarkdownBlock(blockId, definition.markdown);
    await setBlockAttrs(blockId, definition.attrs);
    await this.verifyPersistedReference(blockId, secret.id);
  }

  isParagraphReferenceMarkdown(markdown: string, expectedSecretId?: string): boolean {
    const body = stripBlockIal(markdown).replace(/[\u200B-\u200D\uFEFF]/g, "");
    const urls = [...body.matchAll(/\]\((siyuan:\/\/plugins\/[^)]+)\)/g)].map((match) => match[1]);
    return urls.some((url) => {
      const parsed = this.parseSecretUrl(url);
      return Boolean(parsed && (!expectedSecretId || parsed.secretId === expectedSecretId));
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
    secret: SecretReferenceSource,
    groupName: string,
    target: BlockInsertionTarget,
    cleanupBlockId: string | null,
  ): Promise<void> {
    const definition = this.buildParagraphReference(secret, groupName);
    const inserted = await insertMarkdownBlock(definition.markdown, target);

    if (inserted.dom && !inserted.dom.includes('data-type="NodeParagraph"')) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源没有把 Secret 引用解析为普通段落块；已回滚此次插入");
    }

    try {
      await setBlockAttrs(inserted.id, definition.attrs);
      await this.verifyPersistedReference(inserted.id, secret.id);
    } catch (error) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw error;
    }

    if (cleanupBlockId) await this.cleanupSlashSource(cleanupBlockId);
    showMessage(`已插入秘密：${secret.label}`);
  }

  private async verifyPersistedReference(blockId: string, secretId: string): Promise<void> {
    const [attrs, markdown] = await Promise.all([
      getBlockAttrs(blockId),
      getBlockKramdown(blockId),
    ]);

    if (attrs["custom-secret-vault"] !== "1"
      || attrs["custom-secret-version"] !== SECRET_REFERENCE_VERSION
      || attrs["custom-secret-id"] !== secretId
      || !this.isParagraphReferenceMarkdown(markdown, secretId)) {
      throw new Error("Secret 段落引用持久化验证失败");
    }
  }

  private async cleanupSlashSource(blockId: string): Promise<void> {
    try {
      const kramdown = await getBlockKramdown(blockId);
      const source = normalizeEditorText(stripBlockIal(kramdown));
      if (isSlashOnlyText(source)) await deleteBlock(blockId);
    } catch (error) {
      console.warn("[secret-vault] failed to clean slash source block", blockId, error);
    }
  }
}

function stripBlockIal(markdown: string): string {
  return markdown.replace(/\n?\{:[\s\S]*$/, "");
}

function normalizeEditorText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function isSlashOnlyText(value: string): boolean {
  return /^\/\S*$/.test(value);
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([*_`\[\]])/g, "\\$1");
}
