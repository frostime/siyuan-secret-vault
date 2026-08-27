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

interface V2ReferenceRow {
  id: string;
  root_id: string;
  hpath: string;
  markdown: string;
  secret_id: string | null;
}

/**
 * Repairs v2 references created by 0.4.0/0.4.1.
 *
 * Those releases used iframe `srcdoc`; SiYuan 3.8 sanitizes that attribute on
 * document iframe blocks, leaving an empty about:blank iframe. The repair is
 * explicit, sequential, and uses the authoritative custom-secret-id attribute.
 */
export class DormantReferenceV2RepairMigration implements MigrationTask {
  readonly id = "dormant-reference-v2-srcdoc-repair";
  readonly title = "修复 0.4.0 / 0.4.1 空白引用";
  readonly description = "将被思源清理为 about:blank 的 v2 引用改为非响应式静态壳。已正常的 v2 引用不会出现在扫描结果中。";

  constructor(
    private readonly vault: VaultController,
    private readonly references: SecretReferenceService,
  ) {}

  async inspect(): Promise<MigrationPreview> {
    const rows = await querySql<V2ReferenceRow>(`
      SELECT
        b.id,
        b.root_id,
        b.hpath,
        b.markdown,
        (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-id' LIMIT 1) AS secret_id
      FROM blocks AS b
      WHERE b.id IN (
        SELECT block_id FROM attributes
        WHERE name = 'custom-secret-vault' AND value = '1'
      )
      AND (SELECT value FROM attributes WHERE block_id = b.id AND name = 'custom-secret-version' LIMIT 1) = '2'
      ORDER BY b.updated DESC
    `);

    const items = rows
      .filter((row) => !this.references.isDormantReferenceMarkdown(row.markdown ?? ""))
      .map((row) => this.classify(row));

    return makePreview(this.id, items);
  }

  async run(preview: MigrationPreview): Promise<MigrationRunResult> {
    if (preview.taskId !== this.id) throw new Error("修复预览与当前任务不匹配，请重新扫描");

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
        const outcome = await this.repairOne(candidate.blockId);
        result.items.push({ blockId: candidate.blockId, ok: true, message: outcome.message });
        outcome.changed ? result.migrated += 1 : result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        result.items.push({
          blockId: candidate.blockId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    return result;
  }

  private classify(row: V2ReferenceRow): MigrationPreviewItem {
    const secretId = normalizeId(row.secret_id);
    const base = {
      blockId: row.id,
      rootId: row.root_id,
      documentPath: row.hpath || row.root_id || row.id,
      secretId,
    };

    if (!secretId) {
      return { ...base, label: null, status: "issue", note: "缺少 custom-secret-id，无法安全修复" };
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
      note: "可修复为空白 v2 静态引用",
    };
  }

  private async repairOne(blockId: string): Promise<{ changed: boolean; message: string }> {
    const attrs = await getBlockAttrs(blockId);
    if (attrs["custom-secret-vault"] !== "1" || attrs["custom-secret-version"] !== "2") {
      throw new Error("块已不再是 Secret Vault v2 引用");
    }

    const currentMarkdown = await getBlockKramdown(blockId);
    if (this.references.isDormantReferenceMarkdown(currentMarkdown)) {
      return { changed: false, message: "引用已经正常，无需修复" };
    }

    const secretId = normalizeId(attrs["custom-secret-id"]);
    if (!secretId) throw new Error("缺少 custom-secret-id");
    const secret = this.vault.getSecret(secretId);
    if (!secret) throw new Error("Vault 中已不存在该 Secret");
    const group = this.vault.getGroup(secret.groupId);
    if (!group) throw new Error("Secret 所属分组不存在");

    const definition = this.references.buildDormantReference(secret, group.name, attrs.style ?? "");
    await updateMarkdownBlock(blockId, definition.markdown);
    await setBlockAttrs(blockId, definition.attrs);

    const [verifiedAttrs, verifiedMarkdown] = await Promise.all([
      getBlockAttrs(blockId),
      getBlockKramdown(blockId),
    ]);
    if (verifiedAttrs["custom-secret-version"] !== "2"
      || verifiedAttrs["custom-secret-id"] !== secretId
      || !this.references.isDormantReferenceMarkdown(verifiedMarkdown)) {
      throw new Error("修复后的 v2 引用验证失败；已停止后续写入");
    }

    return { changed: true, message: "已修复" };
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
