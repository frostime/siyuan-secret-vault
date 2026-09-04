import { showMessage } from "siyuan";
import type { AccessContextId, PublicSecretState, VaultSnapshot } from "../types";
import type { VaultController } from "../vault";
import type { MigrationPreview, MigrationRunResult, MigrationTask } from "../migrations/types";

export type DetailMode = "view" | "create" | "edit";
export type WorkspaceSection = "vault" | "migrations";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
}

/**
 * State and behavior of the Secret Vault workspace. Svelte 5 class-store:
 * reactive fields use runes ($state / $derived) and are read from component
 * templates; components stay thin views over this instance.
 */
export class VaultWorkbench {
  private readonly vault: VaultController;
  private readonly contextId: AccessContextId;
  private readonly copySecretReference: (secretId: string) => Promise<void>;
  readonly migrationTasks: MigrationTask[] = [];

  snapshot = $state<VaultSnapshot>({
    revision: 0,
    groups: [],
    secrets: [],
  });

  selectedGroupId = $state("default");
  selectedSecretId = $state<string | null>(null);
  filter = $state("");
  detailMode = $state<DetailMode>("view");
  detailContent = $state("");
  detailLoading = $state(false);
  private detailLoadRevision = 0;

  busy = $state(false);
  errorText = $state("");

  showGroupCreator = $state(false);
  groupName = $state("");
  groupPassword = $state("");

  unlockPassword = $state("");

  editorLabel = $state("");
  editorContent = $state("");
  editingSecretId = $state<string | null>(null);

  showPasswordDialog = $state(false);
  replacementPassword = $state("");

  // Multi-select move state. Selected secret ids always belong to the group
  // currently shown in the list, so the source group is `selectedGroup`.
  // The mode is explicit: checkboxes only appear after the user enters it, so
  // the normal list keeps its original layout with no leading placeholder.
  multiSelectMode = $state(false);
  selectedSecretIds = $state<string[]>([]);
  showMoveDialog = $state(false);
  pendingMoveIds = $state<string[]>([]);
  moveTargetGroupId = $state("");
  moveSourcePassword = $state("");
  moveTargetPassword = $state("");
  moveError = $state("");

  // Plugin-owned confirmation dialog. Native window.confirm is avoided:
  // it blocks the SiYuan window and does not match the vault styling.
  confirmRequest = $state<ConfirmRequest | null>(null);
  confirmError = $state("");
  confirmBusy = $state(false);

  workspaceSection = $state<WorkspaceSection>("vault");
  selectedMigrationId = $state("");
  migrationPreview = $state<MigrationPreview | null>(null);
  migrationResult = $state<MigrationRunResult | null>(null);
  migrationBusy = $state(false);
  migrationError = $state("");

  selectedGroup = $derived(
    this.snapshot.groups.find((group) => group.id === this.selectedGroupId) ?? this.snapshot.groups[0],
  );

  groupSecrets = $derived(
    this.snapshot.secrets.filter((secret) => secret.groupId === this.selectedGroup?.id),
  );

  filteredSecrets = $derived(this.groupSecrets.filter((secret) => {
    const query = this.filter.trim().toLowerCase();
    return !query || secret.label.toLowerCase().includes(query);
  }));

  selectedSecret = $derived(
    this.snapshot.secrets.find((secret) => secret.id === this.selectedSecretId) ?? null,
  );

  selectedMigration = $derived(
    this.migrationTasks.find((task) => task.id === this.selectedMigrationId) ?? this.migrationTasks[0] ?? null,
  );

  migrationFailedItems = $derived(
    this.migrationResult?.items.filter((item) => !item.ok) ?? [],
  );

  moveTargets = $derived(
    this.snapshot.groups.filter((group) => group.id !== this.selectedGroup?.id),
  );

  moveTargetGroup = $derived(
    this.snapshot.groups.find((group) => group.id === this.moveTargetGroupId) ?? null,
  );

  private readonly dateTime = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  constructor(
    vault: VaultController,
    contextId: AccessContextId,
    copySecretReference: (secretId: string) => Promise<void>,
    migrationTasks: MigrationTask[],
  ) {
    this.vault = vault;
    this.contextId = contextId;
    this.copySecretReference = copySecretReference;
    this.migrationTasks = migrationTasks;
    this.selectedMigrationId = migrationTasks[0]?.id ?? "";
  }

  /** Subscribe to the vault snapshot; returns the unsubscribe function. */
  mount(): () => void {
    return this.vault.subscribe(this.contextId, (next) => {
      this.snapshot = next;
      this.reconcileSelection();
      if (this.detailMode === "view") void this.refreshDetailContent();
    });
  }

  private reconcileSelection() {
    // Drop checked ids that no longer exist (deleted or moved elsewhere); the
    // multi-select bar must never offer moving stale secrets.
    this.selectedSecretIds = this.selectedSecretIds.filter((id) =>
      this.snapshot.secrets.some(
        (secret) => secret.id === id && secret.groupId === this.selectedGroupId,
      ),
    );

    if (!this.snapshot.groups.some((group) => group.id === this.selectedGroupId)) {
      this.selectedGroupId = this.snapshot.groups[0]?.id ?? "default";
    }

    if (
      this.selectedSecretId
      && !this.snapshot.secrets.some(
        (secret) => secret.id === this.selectedSecretId && secret.groupId === this.selectedGroupId,
      )
    ) {
      this.selectedSecretId = null;
    }

    if (!this.selectedSecretId) {
      this.selectedSecretId = this.snapshot.secrets.find(
        (secret) => secret.groupId === this.selectedGroupId,
      )?.id ?? null;
    }
  }

  async run<T>(action: () => Promise<T>): Promise<T | undefined> {
    this.busy = true;
    this.errorText = "";
    try {
      return await action();
    } catch (error) {
      this.errorText = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  selectGroup(groupId: string) {
    this.selectedGroupId = groupId;
    this.filter = "";
    this.detailMode = "view";
    this.editorLabel = "";
    this.editorContent = "";
    this.editingSecretId = null;
    this.unlockPassword = "";
    this.errorText = "";
    this.exitMultiSelect();
    this.selectedSecretId = this.snapshot.secrets.find((secret) => secret.groupId === groupId)?.id ?? null;
    void this.refreshDetailContent();
  }

  selectSecret(secret: PublicSecretState) {
    this.selectedSecretId = secret.id;
    this.detailMode = "view";
    this.errorText = "";
    void this.refreshDetailContent();
  }

  async refreshDetailContent() {
    const loadRevision = ++this.detailLoadRevision;
    const secret = this.snapshot.secrets.find((item) => item.id === this.selectedSecretId);
    const group = this.snapshot.groups.find((item) => item.id === secret?.groupId);

    if (!secret || !group?.unlocked) {
      this.detailContent = "";
      this.detailLoading = false;
      return;
    }

    this.detailLoading = true;
    try {
      const content = await this.vault.readSecret(this.contextId, secret.id);
      if (loadRevision === this.detailLoadRevision && this.detailMode === "view") {
        this.detailContent = content;
      }
    } catch (error) {
      if (loadRevision === this.detailLoadRevision) {
        this.detailContent = "";
        this.errorText = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (loadRevision === this.detailLoadRevision) this.detailLoading = false;
    }
  }

  formatTime(timestamp: number): string {
    return Number.isFinite(timestamp) ? this.dateTime.format(new Date(timestamp)) : "—";
  }

  async createGroupInline() {
    const newGroupId = await this.run(() => this.vault.createGroup(this.contextId, this.groupName, this.groupPassword));
    if (!newGroupId) return;

    this.groupName = "";
    this.groupPassword = "";
    this.showGroupCreator = false;
    this.selectGroup(newGroupId);
  }

  lockSelectedGroup(): void {
    if (!this.selectedGroup) return;
    void this.vault.lockGroup(this.contextId, this.selectedGroup.id);
  }

  async unlockSelectedGroup() {
    if (!this.selectedGroup) return;
    const password = this.unlockPassword;
    if (!password) {
      this.errorText = "口令不能为空";
      return;
    }

    const result = await this.run(() => this.vault.unlockGroup(this.contextId, this.selectedGroup!.id, password));
    if (result === undefined && this.errorText) return;

    this.unlockPassword = "";
    void this.refreshDetailContent();
  }

  startCreateSecret() {
    if (!this.selectedGroup?.unlocked) return;
    this.detailMode = "create";
    this.editingSecretId = null;
    this.editorLabel = "";
    this.editorContent = "";
    this.errorText = "";
  }

  async startEditSecret() {
    if (!this.selectedSecret || !this.selectedGroup?.unlocked) return;

    const content = await this.run(() => this.vault.readSecret(this.contextId, this.selectedSecret!.id));
    if (content === undefined) return;

    this.editingSecretId = this.selectedSecret.id;
    this.editorLabel = this.selectedSecret.label;
    this.editorContent = content;
    this.detailMode = "edit";
  }

  cancelEditor() {
    this.detailMode = "view";
    this.editingSecretId = null;
    this.editorLabel = "";
    this.editorContent = "";
    this.errorText = "";
    void this.refreshDetailContent();
  }

  async saveEditor() {
    if (!this.selectedGroup) return;

    if (this.detailMode === "create") {
      const secretId = await this.run(() => this.vault.createSecret(
        this.contextId,
        this.selectedGroup!.id,
        this.editorLabel,
        this.editorContent,
      ));
      if (!secretId) return;
      this.selectedSecretId = secretId;
    } else if (this.detailMode === "edit" && this.editingSecretId) {
      const secretId = this.editingSecretId;
      const result = await this.run(() => this.vault.updateSecret(
        this.contextId,
        secretId,
        this.editorLabel,
        this.editorContent,
      ));
      if (result === undefined && this.errorText) return;
      this.selectedSecretId = secretId;
    }

    this.detailMode = "view";
    this.editingSecretId = null;
    this.editorLabel = "";
    this.editorContent = "";
    void this.refreshDetailContent();
  }

  async copySelectedSecret() {
    if (!this.selectedSecret || !this.selectedGroup?.unlocked) return;
    const content = await this.run(() => this.vault.readSecret(this.contextId, this.selectedSecret!.id));
    if (content === undefined) return;
    await navigator.clipboard.writeText(content);
    showMessage(`已复制：${this.selectedSecret.label}`);
  }

  async copySelectedSecretReference() {
    if (!this.selectedSecret) return;
    await this.run(() => this.copySecretReference(this.selectedSecret!.id));
  }

  openConfirm(request: ConfirmRequest): void {
    this.confirmError = "";
    this.confirmRequest = request;
  }

  cancelConfirm(): void {
    if (this.confirmBusy) return;
    this.confirmRequest = null;
    this.confirmError = "";
  }

  async runConfirm(): Promise<void> {
    if (!this.confirmRequest || this.confirmBusy) return;
    this.confirmBusy = true;
    this.confirmError = "";
    try {
      await this.confirmRequest.action();
      this.confirmRequest = null;
    } catch (error) {
      this.confirmError = error instanceof Error ? error.message : String(error);
    } finally {
      this.confirmBusy = false;
    }
  }

  requestRemoveSelectedSecret() {
    if (!this.selectedSecret || !this.selectedGroup?.unlocked) return;
    this.openConfirm({
      title: "删除秘密",
      message: `确定删除“${this.selectedSecret.label}”？文档中的引用将变成失效引用。`,
      confirmLabel: "删除",
      danger: true,
      action: async () => {
        const deletedId = this.selectedSecret!.id;
        await this.vault.deleteSecret(this.contextId, deletedId);
        this.selectedSecretId = this.snapshot.secrets.find(
          (secret) => secret.groupId === this.selectedGroup!.id && secret.id !== deletedId,
        )?.id ?? null;
        this.detailMode = "view";
        void this.refreshDetailContent();
      },
    });
  }

  requestRemoveSelectedGroup() {
    if (!this.selectedGroup || this.selectedGroup.id === "default") return;
    this.openConfirm({
      title: "删除分组",
      message: `确定删除分组“${this.selectedGroup.name}”？`,
      confirmLabel: "删除",
      danger: true,
      action: async () => {
        await this.vault.deleteGroup(this.selectedGroup!.id);
        this.selectGroup("default");
      },
    });
  }

  // ---- move secrets to another group ----

  enterMultiSelect(): void {
    this.selectedSecretIds = [];
    this.multiSelectMode = true;
  }

  exitMultiSelect(): void {
    this.multiSelectMode = false;
    this.selectedSecretIds = [];
  }

  toggleSecretSelection(secretId: string): void {
    this.selectedSecretIds = this.selectedSecretIds.includes(secretId)
      ? this.selectedSecretIds.filter((id) => id !== secretId)
      : [...this.selectedSecretIds, secretId];
  }

  openMoveDialogFromSelection(): void {
    if (this.selectedSecretIds.length === 0) return;
    this.pendingMoveIds = [...this.selectedSecretIds];
    this.openMoveDialog();
  }

  openMoveDialogForSecret(secretId: string): void {
    const secret = this.snapshot.secrets.find((item) => item.id === secretId);
    if (!secret) return;
    this.pendingMoveIds = [secret.id];
    this.openMoveDialog();
  }

  private openMoveDialog(): void {
    this.moveTargetGroupId = "";
    this.moveSourcePassword = "";
    this.moveTargetPassword = "";
    this.moveError = "";
    this.showMoveDialog = true;
  }

  closeMoveDialog(): void {
    this.showMoveDialog = false;
    this.moveError = "";
  }

  selectMoveTarget(groupId: string): void {
    this.moveTargetGroupId = groupId;
    this.moveError = "";
  }

  async confirmMove(): Promise<void> {
    if (!this.selectedGroup || this.pendingMoveIds.length === 0) return;

    const sourceGroup = this.selectedGroup;
    const targetGroup = this.moveTargetGroup;
    if (!targetGroup) {
      this.moveError = "请选择目标分组";
      return;
    }

    this.busy = true;
    this.moveError = "";
    try {
      // Moving re-encrypts each secret with the target group key, so both
      // groups need an authorized key in this context: the source key to
      // decrypt, the target key to re-encrypt. Unlock whatever is still
      // locked before asking the controller to move.
      if (!sourceGroup.unlocked) {
        if (!this.moveSourcePassword) {
          throw new Error(`请输入源分组「${sourceGroup.name}」的口令`);
        }
        await this.vault.unlockGroup(this.contextId, sourceGroup.id, this.moveSourcePassword);
      }
      if (!targetGroup.unlocked) {
        if (!this.moveTargetPassword) {
          throw new Error(`请输入目标分组「${targetGroup.name}」的口令`);
        }
        await this.vault.unlockGroup(this.contextId, targetGroup.id, this.moveTargetPassword);
      }

      const moved = await this.vault.moveSecrets(this.contextId, [...this.pendingMoveIds], targetGroup.id);

      showMessage(`已移动 ${moved} 个秘密到「${targetGroup.name}」`);
      this.pendingMoveIds = [];
      this.exitMultiSelect();
      this.showMoveDialog = false;
    } catch (error) {
      this.moveError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  async changePassword() {
    if (!this.selectedGroup) return;
    const result = await this.run(() => this.vault.changeGroupPassword(
      this.contextId,
      this.selectedGroup!.id,
      this.replacementPassword,
    ));
    if (result === undefined && this.errorText) return;

    this.replacementPassword = "";
    this.showPasswordDialog = false;
    void this.refreshDetailContent();
  }

  openMigrations() {
    this.workspaceSection = "migrations";
    this.migrationError = "";
  }

  openVaultWorkspace() {
    this.workspaceSection = "vault";
    this.migrationError = "";
  }

  selectMigration(taskId: string) {
    this.selectedMigrationId = taskId;
    this.migrationPreview = null;
    this.migrationResult = null;
    this.migrationError = "";
  }

  async inspectMigration() {
    if (!this.selectedMigration || this.migrationBusy) return;
    this.migrationBusy = true;
    this.migrationError = "";
    this.migrationResult = null;
    try {
      this.migrationPreview = await this.selectedMigration.inspect();
    } catch (error) {
      this.migrationPreview = null;
      this.migrationError = error instanceof Error ? error.message : String(error);
    } finally {
      this.migrationBusy = false;
    }
  }

  requestRunMigration() {
    if (!this.selectedMigration || !this.migrationPreview || this.migrationPreview.ready === 0 || this.migrationBusy) return;
    this.openConfirm({
      title: "执行迁移",
      message: `将串行处理 ${this.migrationPreview.ready} 个文档引用。建议先关闭相关文档，并确保思源同步已完成。是否继续？`,
      confirmLabel: "开始执行",
      action: async () => {
        this.migrationBusy = true;
        this.migrationError = "";
        try {
          this.migrationResult = await this.selectedMigration!.run(this.migrationPreview!);
          this.migrationPreview = await this.selectedMigration!.inspect();
        } catch (error) {
          this.migrationError = error instanceof Error ? error.message : String(error);
        } finally {
          this.migrationBusy = false;
        }
      },
    });
  }
}
