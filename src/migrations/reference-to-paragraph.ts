import type { SecretReferenceService } from "../reference/secret-reference";
import {
  getBlockAttrs,
  getBlockKramdown,
  querySql,
  setBlockAttrs,
  updateMarkdownBlock,
} from "../siyuan/api";
import type { VaultController } from "../vault";
import type {
  MigrationPreview,
  MigrationPreviewItem,
  MigrationRunResult,
  MigrationTask,
} from "./types";

interface ReferenceRow {
  id: string;
  root_id: string;
  hpath: string;
  markdown: string;
  secret_id: string | null;
  version: string | null;
}

/**
 * Explicit v1/v2/v3 -> v4 migration.
 *
 * The task never runs at startup. It keeps the original block ID, rewrites one
 * block at a time, and verifies the persisted paragraph plus authoritative
 * custom-secret-id before continuing to the next document.
 */
export class ReferenceToParagraphMigration implements MigrationTask {
  readonly id = "document-reference-to-paragraph-v4";
  readonly title = "文档引用迁移到普通段落 v4";
  readonly description = "将旧版 IFrame / Widget 引用原地转换为普通段落 + 插件链接。迁移显式触发、串行执行，并保留原 block ID。";

  constructor(
    private readonly pluginName: string,
    private readonly vault: VaultController,
    private readonly references: SecretReferenceService,
  ) {}

  async inspect(): Promise<MigrationPreview> {
    const rows = await querySql<ReferenceRow>(`
      SELECT
        b.id,
        b.root_id,
        b.hpath,
        b.markdown,
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-id' LIMIT 1) AS secret_id,
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-version' LIMIT 1) AS version
      FROM blocks AS b
      WHERE b.id IN (
        SELECT block_id FROM attributes
        WHERE name = 'custom-secret-vault' AND value = '1'
      )
      AND COALESCE(
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-version' LIMIT 1),
        ''
      ) <> '4'
      ORDER BY b.updated DESC
    `);

    return makePreview(this.id, rows.map((row) => this.classify(row)));
  }

  async run(preview: MigrationPreview): Promise<MigrationRunResult> {
    if (preview.taskId !== this.id) throw new Error("迁移预览与当前任务不匹配，请重新扫描");

    const result: MigrationRunResult = {
      taskId: this.id,
      attempted: 0,
      migrated: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };

    for (const candidate of preview.items.filter((item) => item.status === "ready")) {
      result.attempted += 1;
      try {
        const outcome = await this.migrateOne(candidate.blockId);
        result.items.push({ blockId: candidate.blockId, ok: true, message: outcome.message });
        outcome.changed ? result.migrated += 1 : result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        result.items.push({
          blockId: candidate.blockId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        // A format/API mismatch is likely systemic. Stop before repeating the
        // same assumption across more user documents.
        break;
      }
    }
    return result;
  }

  private classify(row: ReferenceRow): MigrationPreviewItem {
    const secretId = normalizeId(row.secret_id);
    const version = normalizeVersion(row.version);
    const base = {
      blockId: row.id,
      rootId: row.root_id,
      documentPath: row.hpath || row.root_id || row.id,
      secretId,
    };

    if (!secretId) {
      return { ...base, label: null, status: "issue", note: "缺少 custom-secret-id，无法确定权威 Secret" };
    }

    const formatIssue = validateLegacyFormat(version, row.markdown ?? "", this.pluginName, secretId);
    if (formatIssue) return { ...base, label: null, status: "issue", note: formatIssue };

    const secret = this.vault.getSecret(secretId);
    if (!secret) {
      return { ...base, label: null, status: "issue", note: "Vault 中已不存在该 Secret" };
    }
    const group = this.vault.getGroup(secret.groupId);
    if (!group) {
      return { ...base, label: secret.label, status: "issue", note: "Secret 所属分组不存在" };
    }

    return {
      ...base,
      label: secret.label,
      status: "ready",
      note: `可从 v${version} 原地迁移为普通段落 v4`,
    };
  }

  private async migrateOne(blockId: string): Promise<{ changed: boolean; message: string }> {
    const attrs = await getBlockAttrs(blockId);
    if (attrs["custom-secret-vault"] !== "1") throw new Error("块已不再属于 Secret Vault");
    if (attrs["custom-secret-version"] === "4") {
      return { changed: false, message: "已经是 v4 普通段落引用" };
    }

    const secretId = normalizeId(attrs["custom-secret-id"]);
    if (!secretId) throw new Error("缺少 custom-secret-id");

    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("Vault 中已不存在该 Secret");
    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("Secret 所属分组不存在");

    const currentMarkdown = await getBlockKramdown(blockId);
    const version = normalizeVersion(attrs["custom-secret-version"]);
    const formatIssue = validateLegacyFormat(version, currentMarkdown, this.pluginName, secretId);
    if (formatIssue) throw new Error(formatIssue);

    const definition = this.references.buildParagraphReference(secret, group.name);
    await updateMarkdownBlock(blockId, definition.markdown);
    await setBlockAttrs(blockId, {
      ...definition.attrs,
      style: removeLegacyHeight(attrs.style ?? ""),
    });

    const [verifiedAttrs, verifiedMarkdown] = await Promise.all([
      getBlockAttrs(blockId),
      getBlockKramdown(blockId),
    ]);
    if (verifiedAttrs["custom-secret-version"] !== "4"
      || verifiedAttrs["custom-secret-id"] !== secretId
      || !this.references.isParagraphReferenceMarkdown(verifiedMarkdown, secretId)) {
      throw new Error("v4 普通段落引用验证失败；已停止后续写入，可重新扫描后重试");
    }

    return { changed: true, message: `已从 v${version} 迁移为普通段落 v4` };
  }
}

function makePreview(taskId: string, items: MigrationPreviewItem[]): MigrationPreview {
  const ready = items.filter((item) => item.status === "ready").length;
  return {
    taskId,
    scannedAt: Date.now(),
    total: items.length,
    ready,
    issues: items.length - ready,
    items,
  };
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function normalizeVersion(value: string | null | undefined): string {
  return value?.trim() || "1";
}

function validateLegacyFormat(
  version: string,
  markdown: string,
  pluginName: string,
  secretId: string,
): string | null {
  if (version === "1") {
    const legacyId = parseLegacySecretId(markdown, pluginName);
    if (!legacyId) return "v1 块内容不是可识别的 Secret Vault IFrame";
    if (legacyId !== secretId) return "块属性 Secret ID 与旧 IFrame URL 不一致，已拒绝猜测";
    return null;
  }

  if (version === "2") {
    return /<iframe\b/i.test(stripBlockIal(markdown))
      ? null
      : "v2 块内容已变化，不再是可识别的 IFrame 引用";
  }

  if (version === "3") {
    return isLegacyWidget(markdown)
      ? null
      : "v3 块内容已变化，不再是可识别的 Secret Vault Widget";
  }

  return `未知引用版本 ${version || "(空)"}，未自动迁移`;
}

function parseLegacySecretId(markdown: string, pluginName: string): string | null {
  const iframe = stripBlockIal(markdown).match(/<iframe\b[^>]*>/i)?.[0] ?? "";
  const srcMatch = iframe.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
  if (!src) return null;

  try {
    const url = new URL(src, location.origin);
    if (url.pathname !== `/plugins/${pluginName}/embed/index.html`) return null;
    return normalizeId(url.searchParams.get("secret"));
  } catch {
    return null;
  }
}

function isLegacyWidget(markdown: string): boolean {
  const iframe = stripBlockIal(markdown).match(/<iframe\b[^>]*>/i)?.[0] ?? "";
  return /data-subtype\s*=\s*["']widget["']/i.test(iframe)
    && /\/widgets\/siyuan-secret-vault-widget/i.test(iframe);
}

function stripBlockIal(markdown: string): string {
  return markdown.replace(/\n?\{:[\s\S]*$/, "").trim();
}

function removeLegacyHeight(style: string): string {
  const declarations = style
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && !/^height\s*:/i.test(item));

  return declarations.length > 0 ? `${declarations.join("; ")};` : "";
}
