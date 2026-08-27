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

interface LegacyReferenceRow {
  id: string;
  root_id: string;
  hpath: string;
  markdown: string;
  secret_id: string | null;
  version: string | null;
}

type ParsedReference =
  | { kind: "legacy" | "dormant"; secretId: string }
  | { kind: "unknown"; secretId: null };

/**
 * Explicit v1 -> v2 document-reference migration.
 *
 * Discovery is read-only. Migration is sequential and re-validates every block
 * immediately before writing so a stale preview cannot rewrite a block that the
 * user changed after scanning. Secret ID from block attributes remains the
 * authoritative identity; URL/srcdoc identity is used only as a consistency
 * check and is never guessed through conflicts.
 */
export class LegacyReferenceV1ToV2Migration implements MigrationTask {
  readonly id = "legacy-reference-v1-to-v2";
  readonly title = "旧版文档引用 v1 → v2";
  readonly description = "将旧版自动加载 iframe 转换为默认静态休眠的 v2 引用。迁移只在你明确执行时修改文档。";

  constructor(
    private readonly pluginName: string,
    private readonly vault: VaultController,
    private readonly references: SecretReferenceService,
  ) {}

  async inspect(): Promise<MigrationPreview> {
    const rows = await querySql<LegacyReferenceRow>(`
      SELECT
        b.id,
        b.root_id,
        b.hpath,
        b.markdown,
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-id' LIMIT 1) AS secret_id,
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-version' LIMIT 1) AS version
      FROM blocks AS b
      WHERE b.id IN (
        SELECT block_id
        FROM attributes
        WHERE name = 'custom-secret-vault' AND value = '1'
      )
      AND COALESCE(
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-version' LIMIT 1),
        '1'
      ) IN ('', '1')
      ORDER BY b.updated DESC
    `);

    const items = rows.map((row) => this.classifyRow(row));
    return makePreview(this.id, items);
  }

  async run(preview: MigrationPreview): Promise<MigrationRunResult> {
    if (preview.taskId !== this.id) throw new Error("迁移预览与当前任务不匹配，请重新扫描");

    const candidates = preview.items.filter((item) => item.status === "ready");
    const result: MigrationRunResult = {
      taskId: this.id,
      attempted: 0,
      migrated: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };

    // Intentionally serial: document migration is maintenance work, not a
    // throughput path. One kernel transaction settling before the next keeps
    // failure boundaries and the debug story local to one block.
    for (const candidate of candidates) {
      result.attempted += 1;
      try {
        const outcome = await this.migrateOne(candidate.blockId);
        result.items.push({ blockId: candidate.blockId, ok: true, message: outcome.message });
        if (outcome.changed) result.migrated += 1;
        else result.skipped += 1;
      } catch (error) {
        result.items.push({
          blockId: candidate.blockId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        result.failed += 1;
        // A first failure can indicate an upstream block-format/API change. Stop
        // rather than repeating the same destructive assumption across more
        // documents. The task is idempotent and can be re-scanned after review.
        break;
      }
    }

    return result;
  }

  private classifyRow(row: LegacyReferenceRow): MigrationPreviewItem {
    const secretId = normalizeId(row.secret_id);
    const parsed = parseReference(row.markdown ?? "", this.pluginName);
    const base = {
      blockId: row.id,
      rootId: row.root_id,
      documentPath: row.hpath || row.root_id || row.id,
      secretId,
    };

    if (!secretId) {
      return { ...base, label: null, status: "issue", note: "缺少 custom-secret-id，无法确定权威 Secret" };
    }
    if (parsed.kind === "unknown") {
      return { ...base, label: null, status: "issue", note: "块内容不是可识别的 Secret Vault v1/v2 iframe" };
    }
    if (parsed.secretId !== secretId) {
      return { ...base, label: null, status: "issue", note: "块属性 Secret ID 与 iframe 内容不一致，已拒绝猜测" };
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
      note: parsed.kind === "dormant" ? "可修复未完成的 v2 元数据" : "可迁移为 v2 静态休眠引用",
    };
  }

  private async migrateOne(blockId: string): Promise<{ changed: boolean; message: string }> {
    const attrs = await getBlockAttrs(blockId);
    if (attrs["custom-secret-vault"] !== "1") {
      throw new Error("块已不再属于 Secret Vault");
    }
    if (attrs["custom-secret-version"] === "2") {
      return { changed: false, message: "已经是 v2，无需重复修改" };
    }

    const secretId = normalizeId(attrs["custom-secret-id"]);
    if (!secretId) throw new Error("缺少 custom-secret-id");

    const currentMarkdown = await getBlockKramdown(blockId);
    const parsed = parseReference(currentMarkdown, this.pluginName);
    if (parsed.kind === "unknown") throw new Error("块内容已变化，不再是可识别的 Secret Vault 引用");
    if (parsed.secretId !== secretId) throw new Error("块属性与 iframe Secret ID 已发生冲突");

    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("Vault 中已不存在该 Secret");
    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("Secret 所属分组不存在");

    const definition = this.references.buildDormantReference(secret, group.name, attrs.style ?? "");

    await updateMarkdownBlock(blockId, definition.markdown);
    await setBlockAttrs(blockId, definition.attrs);

    // Verify the two invariants that make the migration idempotent: v2 marker
    // and a dormant reference whose embedded identity agrees with attributes.
    const [verifiedAttrs, verifiedMarkdown] = await Promise.all([
      getBlockAttrs(blockId),
      getBlockKramdown(blockId),
    ]);
    if (verifiedAttrs["custom-secret-version"] !== "2") {
      throw new Error("块内容已更新，但 v2 属性验证失败；可重新扫描后重试");
    }

    const verified = parseReference(verifiedMarkdown, this.pluginName);
    if (verified.kind !== "dormant" || verified.secretId !== secretId) {
      throw new Error("v2 静态引用验证失败；请保留该块并重新扫描");
    }

    return { changed: true, message: "已迁移" };
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

function parseReference(markdown: string, pluginName: string): ParsedReference {
  const html = stripKramdownIAL(markdown).trim();
  if (!html) return { kind: "unknown", secretId: null };

  const document = new DOMParser().parseFromString(html, "text/html");
  const iframe = document.querySelector("iframe");
  if (!iframe) return { kind: "unknown", secretId: null };

  const expectedLegacyPath = `/plugins/${pluginName}/embed/index.html`;
  const expectedLivePath = `/plugins/${pluginName}/embed/live.html`;
  const src = iframe.getAttribute("src");

  if (src) {
    const url = parseUrl(src);
    if (url?.pathname === expectedLegacyPath) {
      const secretId = normalizeId(url.searchParams.get("secret"));
      return secretId ? { kind: "legacy", secretId } : { kind: "unknown", secretId: null };
    }
  }

  const srcdoc = iframe.getAttribute("srcdoc");
  if (!srcdoc) return { kind: "unknown", secretId: null };

  const srcdocDocument = new DOMParser().parseFromString(srcdoc, "text/html");
  const link = srcdocDocument.querySelector<HTMLAnchorElement>("a[href]");
  const href = link?.getAttribute("href") ?? "";
  const liveUrl = parseUrl(href);
  if (liveUrl?.pathname !== expectedLivePath) return { kind: "unknown", secretId: null };

  const secretId = normalizeId(liveUrl.searchParams.get("secret"));
  return secretId ? { kind: "dormant", secretId } : { kind: "unknown", secretId: null };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value, location.origin);
  } catch {
    return null;
  }
}

function stripKramdownIAL(markdown: string): string {
  return markdown.replace(/\n?\{:[\s\S]*$/, "");
}
