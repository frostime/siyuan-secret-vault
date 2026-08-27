export type MigrationItemStatus = "ready" | "issue";

export interface MigrationPreviewItem {
  blockId: string;
  rootId: string;
  documentPath: string;
  secretId: string | null;
  label: string | null;
  status: MigrationItemStatus;
  note: string;
}

export interface MigrationPreview {
  taskId: string;
  scannedAt: number;
  total: number;
  ready: number;
  issues: number;
  items: MigrationPreviewItem[];
}

export interface MigrationRunItem {
  blockId: string;
  ok: boolean;
  message: string;
}

export interface MigrationRunResult {
  taskId: string;
  attempted: number;
  migrated: number;
  skipped: number;
  failed: number;
  items: MigrationRunItem[];
}

/**
 * One explicit, user-triggered migration unit exposed by the Vault tab.
 *
 * The UI owns only presentation/progress. Each task owns discovery, validation,
 * migration semantics, and its retry/idempotency rules.
 */
export interface MigrationTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  inspect(): Promise<MigrationPreview>;
  run(preview: MigrationPreview): Promise<MigrationRunResult>;
}
