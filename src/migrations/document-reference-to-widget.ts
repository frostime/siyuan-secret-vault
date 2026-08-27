import type { SecretReferenceService } from "../editor/secret-reference";
import {
  getBlockAttrs,
  getBlockKramdown,
  querySql,
  setBlockAttrs,
  updateMarkdownBlock,
} from "../editor/siyuan-api";
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
 * Explicit migration from legacy Secret Vault iframe references to v3 NodeWidget.
 *
 * The task is deliberately user-triggered, sequential, and idempotent. A
 * partially migrated block whose markdown already became NodeWidget can be
 * completed on a later run because authoritative identity still lives in
 * custom-secret-id.
 */
export class DocumentReferenceToWidgetMigration implements MigrationTask {
  readonly id = "document-reference-to-widget-v3";
  readonly title = "文档引用迁移到挂件 v3";
  readonly description = "将旧版 v1/v2 IFrame 引用原地转换为思源原生挂件块。迁移不会打开文档，且只在你明确执行时写入。";

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
      ) <> '3'
      ORDER BY b.updated DESC
    `);

    const items = rows.map((row) => this.classify(row));
    return makePreview(this.id, items);
  }

  async run(preview: MigrationPreview): Promise<MigrationRunResult> {
    if (preview.taskId !== this.id) throw new Error("迁移预览与当前任务不匹配，请重新扫描");

    await this.references.ensureWidgetAvailable();

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
        // A format/API mismatch is a system-level signal. Stop before repeating
        // the same assumption across more documents.
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

    const currentIsWidget = this.references.isWidgetReferenceMarkdown(row.markdown ?? "");
    if (!currentIsWidget && version === "1") {
      const legacyId = parseLegacySecretId(row.markdown ?? "", this.pluginName);
      if (!legacyId) {
        return { ...base, label: null, status: "issue", note: "v1 块内容不是可识别的 Secret Vault IFrame" };
      }
      if (legacyId !== secretId) {
        return { ...base, label: null, status: "issue", note: "块属性 Secret ID 与旧 IFrame URL 不一致，已拒绝猜测" };
      }
    }

    if (!currentIsWidget && version !== "1" && version !== "2") {
      return { ...base, label: null, status: "issue", note: `未知引用版本 ${version || "(空)"}，未自动迁移` };
    }

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
      note: currentIsWidget
        ? "挂件内容已写入但版本属性未完成，可安全补全"
        : `可从 v${version || "?"} 迁移为 NodeWidget v3`,
    };
  }

  private async migrateOne(blockId: string): Promise<{ changed: boolean; message: string }> {
    const attrs = await getBlockAttrs(blockId);
    if (attrs["custom-secret-vault"] !== "1") {
      throw new Error("块已不再属于 Secret Vault");
    }
    if (attrs["custom-secret-version"] === "3") {
      return { changed: false, message: "已经是 v3 挂件引用" };
    }

    const secretId = normalizeId(attrs["custom-secret-id"]);
    if (!secretId) throw new Error("缺少 custom-secret-id");

    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("Vault 中已不存在该 Secret");
    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("Secret 所属分组不存在");

    const currentMarkdown = await getBlockKramdown(blockId);
    const alreadyWidget = this.references.isWidgetReferenceMarkdown(currentMarkdown);
    const version = normalizeVersion(attrs["custom-secret-version"]);

    if (!alreadyWidget) {
      if (version === "1") {
        const legacyId = parseLegacySecretId(currentMarkdown, this.pluginName);
        if (!legacyId) throw new Error("v1 块内容已变化，不再是可识别的 Secret Vault IFrame");
        if (legacyId !== secretId) throw new Error("块属性与旧 IFrame Secret ID 已发生冲突");
      } else if (version !== "2") {
        throw new Error(`不支持从引用版本 ${version || "(空)"} 自动迁移`);
      }
    }

    const definition = this.references.buildWidgetReference(secret, group.name, attrs.style ?? "");
    if (!alreadyWidget) {
      await updateMarkdownBlock(blockId, definition.markdown);
    }
    await setBlockAttrs(blockId, definition.attrs);

    const [verifiedAttrs, verifiedMarkdown] = await Promise.all([
      getBlockAttrs(blockId),
      getBlockKramdown(blockId),
    ]);
    if (verifiedAttrs["custom-secret-version"] !== "3"
      || verifiedAttrs["custom-secret-id"] !== secretId
      || !this.references.isWidgetReferenceMarkdown(verifiedMarkdown)) {
      throw new Error("v3 挂件引用验证失败；已停止后续写入，可重新扫描后重试");
    }

    return { changed: true, message: "已迁移为 NodeWidget v3" };
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

function parseLegacySecretId(markdown: string, pluginName: string): string | null {
  const html = markdown.replace(/\n?\{:[\s\S]*$/, "").trim();
  const iframe = html.match(/<iframe\b[^>]*>/i)?.[0] ?? "";
  if (!iframe) return null;

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
