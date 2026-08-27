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

export interface SlashTarget {
  insertion: BlockInsertionTarget;
  cleanupBlockId: string | null;
}

/**
 * Owns the persistent SiYuan representation of a Secret reference.
 *
 * Version 2 references are dormant document-owned snapshots. Their srcdoc has
 * no script and does not contact the plugin. The only active transition is the
 * user's explicit link navigation to live.html. Secret ID remains authoritative;
 * all other custom attributes are non-authoritative display metadata.
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
    const liveHref = `/plugins/${this.pluginName}/embed/live.html?secret=${encodeURIComponent(secret.id)}`;
    const srcdoc = buildDormantSrcdoc(secret.label, groupName, liveHref);
    const iframe = [
      '<iframe loading="lazy"',
      ` srcdoc="${escapeHtmlAttribute(srcdoc)}"`,
      ` style="width: 100%; height: 100%; border: 0; border-radius: 6px;"`,
      "></iframe>",
    ].join("");

    const inserted = await insertMarkdownBlock(iframe, target);

    // Standalone <iframe> must become a real NodeIFrame. Fail closed if a
    // future Lute version changes this parse rule.
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
        "custom-secret-label": secret.label,
        "custom-secret-group-name": groupName,
        "custom-secret-created-at": String(secret.createdAt),
        "custom-secret-updated-at": String(secret.updatedAt),
        "custom-secret-version": REFERENCE_VERSION,
        style: mergeInitialHeight(attrs.style ?? "", DEFAULT_EMBED_HEIGHT),
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

function buildDormantSrcdoc(label: string, groupName: string, liveHref: string): string {
  const safeLabel = escapeHtmlText(label || "Secret");
  const safeGroup = escapeHtmlText(groupName || "Secret Vault");
  const safeHref = escapeHtmlAttribute(liveHref);

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:CanvasText;background:transparent}body{padding:8px}.card{min-height:148px;padding:14px 16px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;background:color-mix(in srgb,Canvas 98%,currentColor 2%);display:flex;align-items:center;justify-content:space-between;gap:16px}.identity{min-width:0}.label{display:block;font-size:14px;font-weight:650;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{display:block;margin-top:4px;font-size:11px;opacity:.58}.connect{flex:0 0 auto;padding:5px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;color:inherit;text-decoration:none;font-size:12px}.connect:hover{background:color-mix(in srgb,currentColor 7%,transparent)}</style></head><body><main class="card"><div class="identity"><strong class="label">🔐 ${safeLabel}</strong><span class="meta">${safeGroup} · 静态引用</span></div><a class="connect" href="${safeHref}">连接</a></main></body></html>`;
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
