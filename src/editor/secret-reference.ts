import { showMessage, type Protyle } from "siyuan";
import type { SecretRecord } from "../types";
import type { BundledWidgetInstaller } from "../widget/bundled-widget-installer";
import { SECRET_VAULT_WIDGET_URL } from "../widget/bundled-widget-installer";
import {
  deleteBlock,
  getBlockAttrs,
  getBlockKramdown,
  insertMarkdownBlock,
  setBlockAttrs,
  type BlockInsertionTarget,
} from "./siyuan-api";

const REFERENCE_VERSION = "3";
const DEFAULT_WIDGET_HEIGHT = 178;

export type SecretReferenceSource = Pick<
  SecretRecord,
  "id" | "groupId" | "label" | "createdAt" | "updatedAt"
>;

export interface WidgetReferenceDefinition {
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
 * Version 3 uses SiYuan's native NodeWidget representation instead of a
 * generic NodeIFrame. The widget owns the dormant document presentation and
 * contacts the plugin only after the user explicitly clicks Connect. Secret ID
 * is authoritative; the remaining custom attributes are display snapshots.
 */
export class SecretReferenceService {
  constructor(private readonly widgetInstaller: BundledWidgetInstaller) {}

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

  async ensureWidgetAvailable(): Promise<void> {
    await this.widgetInstaller.ensureInstalled();
  }

  /** Builds the complete persistent v3 representation without writing it. */
  buildWidgetReference(
    secret: SecretReferenceSource,
    groupName: string,
    existingStyle = "",
  ): WidgetReferenceDefinition {
    return {
      // Follow SiYuan's canonical NodeWidget representation. Avoid extra iframe
      // attributes so Lute/Protyle can own widget lifecycle and rendering.
      markdown: `<iframe src="${SECRET_VAULT_WIDGET_URL}" data-subtype="widget"></iframe>`,
      attrs: {
        "custom-secret-vault": "1",
        "custom-secret-id": secret.id,
        "custom-secret-group": secret.groupId,
        "custom-secret-label": secret.label,
        "custom-secret-group-name": groupName,
        "custom-secret-created-at": String(secret.createdAt),
        "custom-secret-updated-at": String(secret.updatedAt),
        "custom-secret-version": REFERENCE_VERSION,
        style: mergeInitialHeight(existingStyle, DEFAULT_WIDGET_HEIGHT),
      },
    };
  }

  isWidgetReferenceMarkdown(markdown: string): boolean {
    const html = stripBlockIal(markdown).trim();
    const iframe = html.match(/<iframe\b[^>]*>/i)?.[0] ?? "";
    if (!iframe) return false;

    const src = extractHtmlAttribute(iframe, "src");
    const subtype = extractHtmlAttribute(iframe, "data-subtype");
    if (src === null || subtype !== "widget") return false;

    try {
      const url = new URL(src, location.origin);
      const normalized = url.pathname.replace(/\/$/, "");
      return normalized === SECRET_VAULT_WIDGET_URL;
    } catch {
      return false;
    }
  }

  /** Validates the authoritative reference identity during an explicit session handshake. */
  async matchesReference(blockId: string, secretId: string): Promise<boolean> {
    const attrs = await getBlockAttrs(blockId);
    return attrs["custom-secret-vault"] === "1"
      && attrs["custom-secret-version"] === REFERENCE_VERSION
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
    await this.ensureWidgetAvailable();

    const initialDefinition = this.buildWidgetReference(secret, groupName);
    const inserted = await insertMarkdownBlock(initialDefinition.markdown, target);

    if (inserted.dom && !inserted.dom.includes('data-type="NodeWidget"')) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源没有把 Secret 引用解析为挂件块；已回滚此次插入");
    }

    const persistedMarkdown = await getBlockKramdown(inserted.id);
    if (!this.isWidgetReferenceMarkdown(persistedMarkdown)) {
      await deleteBlock(inserted.id).catch(() => undefined);
      throw new Error("思源改写了 Secret 挂件引用；已回滚此次插入");
    }

    try {
      const attrs = await getBlockAttrs(inserted.id);
      const definition = this.buildWidgetReference(secret, groupName, attrs.style ?? "");
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

      if (isSlashOnlyText(source)) {
        await deleteBlock(blockId);
      }
    } catch (error) {
      console.warn("[secret-vault] failed to clean slash source block", blockId, error);
    }
  }
}

function stripBlockIal(markdown: string): string {
  return markdown.replace(/\n?\{:[\s\S]*$/, "");
}

function extractHtmlAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function normalizeEditorText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function isSlashOnlyText(value: string): boolean {
  return /^\/\S*$/.test(value);
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
