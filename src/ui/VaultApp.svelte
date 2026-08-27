<script lang="ts">
  import { onMount } from "svelte";
  import { showMessage } from "siyuan";
  import type { AccessContextId, PublicSecretState, VaultSnapshot } from "../types";
  import type { VaultController } from "../vault";
  import type { MigrationPreview, MigrationRunResult, MigrationTask } from "../migrations/types";

  type DetailMode = "view" | "create" | "edit";
  type WorkspaceSection = "vault" | "migrations";

  let {
    vault,
    contextId,
    insertSecret,
    migrationTasks,
  } = $props<{
    vault: VaultController;
    contextId: AccessContextId;
    insertSecret: (secretId: string) => Promise<void>;
    migrationTasks: MigrationTask[];
  }>();

  let snapshot = $state<VaultSnapshot>({
    revision: 0,
    groups: [],
    secrets: [],
  });

  let selectedGroupId = $state("default");
  let selectedSecretId = $state<string | null>(null);
  let filter = $state("");
  let detailMode = $state<DetailMode>("view");
  let detailContent = $state("");
  let detailLoading = $state(false);
  let detailLoadRevision = 0;

  let busy = $state(false);
  let errorText = $state("");

  let showGroupCreator = $state(false);
  let groupName = $state("");
  let groupPassword = $state("");

  let unlockPassword = $state("");

  let editorLabel = $state("");
  let editorContent = $state("");
  let editingSecretId = $state<string | null>(null);

  let showPasswordDialog = $state(false);
  let replacementPassword = $state("");

  let workspaceSection = $state<WorkspaceSection>("vault");
  let selectedMigrationId = $state(migrationTasks[0]?.id ?? "");
  let migrationPreview = $state<MigrationPreview | null>(null);
  let migrationResult = $state<MigrationRunResult | null>(null);
  let migrationBusy = $state(false);
  let migrationError = $state("");

  const selectedGroup = $derived(
    snapshot.groups.find((group) => group.id === selectedGroupId) ?? snapshot.groups[0],
  );

  const groupSecrets = $derived(
    snapshot.secrets.filter((secret) => secret.groupId === selectedGroup?.id),
  );

  const filteredSecrets = $derived(groupSecrets.filter((secret) => {
    const query = filter.trim().toLowerCase();
    return !query || secret.label.toLowerCase().includes(query);
  }));

  const selectedSecret = $derived(
    snapshot.secrets.find((secret) => secret.id === selectedSecretId) ?? null,
  );

  const selectedMigration = $derived(
    migrationTasks.find((task) => task.id === selectedMigrationId) ?? migrationTasks[0] ?? null,
  );

  const dateTime = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  onMount(() => vault.subscribe(contextId, (next) => {
    snapshot = next;
    reconcileSelection();
    if (detailMode === "view") void refreshDetailContent();
  }));

  function reconcileSelection() {
    if (!snapshot.groups.some((group) => group.id === selectedGroupId)) {
      selectedGroupId = snapshot.groups[0]?.id ?? "default";
    }

    if (
      selectedSecretId
      && !snapshot.secrets.some(
        (secret) => secret.id === selectedSecretId && secret.groupId === selectedGroupId,
      )
    ) {
      selectedSecretId = null;
    }

    if (!selectedSecretId) {
      selectedSecretId = snapshot.secrets.find(
        (secret) => secret.groupId === selectedGroupId,
      )?.id ?? null;
    }
  }

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    busy = true;
    errorText = "";
    try {
      return await action();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      busy = false;
    }
  }

  function selectGroup(groupId: string) {
    selectedGroupId = groupId;
    filter = "";
    detailMode = "view";
    editorLabel = "";
    editorContent = "";
    editingSecretId = null;
    unlockPassword = "";
    errorText = "";
    selectedSecretId = snapshot.secrets.find((secret) => secret.groupId === groupId)?.id ?? null;
    void refreshDetailContent();
  }

  function selectSecret(secret: PublicSecretState) {
    selectedSecretId = secret.id;
    detailMode = "view";
    errorText = "";
    void refreshDetailContent();
  }

  async function refreshDetailContent() {
    const loadRevision = ++detailLoadRevision;
    const secret = snapshot.secrets.find((item) => item.id === selectedSecretId);
    const group = snapshot.groups.find((item) => item.id === secret?.groupId);

    if (!secret || !group?.unlocked) {
      detailContent = "";
      detailLoading = false;
      return;
    }

    detailLoading = true;
    try {
      const content = await vault.readSecret(contextId, secret.id);
      if (loadRevision === detailLoadRevision && detailMode === "view") {
        detailContent = content;
      }
    } catch (error) {
      if (loadRevision === detailLoadRevision) {
        detailContent = "";
        errorText = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (loadRevision === detailLoadRevision) detailLoading = false;
    }
  }

  function formatTime(timestamp: number): string {
    return Number.isFinite(timestamp) ? dateTime.format(new Date(timestamp)) : "—";
  }

  async function createGroupInline() {
    const newGroupId = await run(() => vault.createGroup(contextId, groupName, groupPassword));
    if (!newGroupId) return;

    groupName = "";
    groupPassword = "";
    showGroupCreator = false;
    selectGroup(newGroupId);
  }

  async function unlockSelectedGroup() {
    if (!selectedGroup) return;
    const password = unlockPassword;
    if (!password) {
      errorText = "口令不能为空";
      return;
    }

    const result = await run(() => vault.unlockGroup(contextId, selectedGroup.id, password));
    if (result === undefined && errorText) return;

    unlockPassword = "";
    void refreshDetailContent();
  }

  function startCreateSecret() {
    if (!selectedGroup?.unlocked) return;
    detailMode = "create";
    editingSecretId = null;
    editorLabel = "";
    editorContent = "";
    errorText = "";
  }

  async function startEditSecret() {
    if (!selectedSecret || !selectedGroup?.unlocked) return;

    const content = await run(() => vault.readSecret(contextId, selectedSecret.id));
    if (content === undefined) return;

    editingSecretId = selectedSecret.id;
    editorLabel = selectedSecret.label;
    editorContent = content;
    detailMode = "edit";
  }

  function cancelEditor() {
    detailMode = "view";
    editingSecretId = null;
    editorLabel = "";
    editorContent = "";
    errorText = "";
    void refreshDetailContent();
  }

  async function saveEditor() {
    if (!selectedGroup) return;

    if (detailMode === "create") {
      const secretId = await run(() => vault.createSecret(
        contextId,
        selectedGroup.id,
        editorLabel,
        editorContent,
      ));
      if (!secretId) return;
      selectedSecretId = secretId;
    } else if (detailMode === "edit" && editingSecretId) {
      const secretId = editingSecretId;
      const result = await run(() => vault.updateSecret(
        contextId,
        secretId,
        editorLabel,
        editorContent,
      ));
      if (result === undefined && errorText) return;
      selectedSecretId = secretId;
    }

    detailMode = "view";
    editingSecretId = null;
    editorLabel = "";
    editorContent = "";
    void refreshDetailContent();
  }

  async function copySelectedSecret() {
    if (!selectedSecret || !selectedGroup?.unlocked) return;
    const content = await run(() => vault.readSecret(contextId, selectedSecret.id));
    if (content === undefined) return;
    await navigator.clipboard.writeText(content);
    showMessage(`已复制：${selectedSecret.label}`);
  }

  async function insertSelectedSecret() {
    if (!selectedSecret) return;
    await run(() => insertSecret(selectedSecret.id));
  }

  async function removeSelectedSecret() {
    if (!selectedSecret || !selectedGroup?.unlocked) return;
    if (!confirm(`确定删除“${selectedSecret.label}”？文档中的引用将变成失效引用。`)) return;

    const deletedId = selectedSecret.id;
    await run(() => vault.deleteSecret(contextId, deletedId));
    if (errorText) return;

    selectedSecretId = snapshot.secrets.find(
      (secret) => secret.groupId === selectedGroup.id && secret.id !== deletedId,
    )?.id ?? null;
    detailMode = "view";
    void refreshDetailContent();
  }

  async function removeSelectedGroup() {
    if (!selectedGroup || selectedGroup.id === "default") return;
    if (!confirm(`确定删除分组“${selectedGroup.name}”？`)) return;

    await run(() => vault.deleteGroup(selectedGroup.id));
    if (!errorText) selectGroup("default");
  }

  async function changePassword() {
    if (!selectedGroup) return;
    const result = await run(() => vault.changeGroupPassword(
      contextId,
      selectedGroup.id,
      replacementPassword,
    ));
    if (result === undefined && errorText) return;

    replacementPassword = "";
    showPasswordDialog = false;
    void refreshDetailContent();
  }

  function openMigrations() {
    workspaceSection = "migrations";
    migrationError = "";
  }

  function openVaultWorkspace() {
    workspaceSection = "vault";
    migrationError = "";
  }

  function selectMigration(taskId: string) {
    selectedMigrationId = taskId;
    migrationPreview = null;
    migrationResult = null;
    migrationError = "";
  }

  async function inspectMigration() {
    if (!selectedMigration || migrationBusy) return;
    migrationBusy = true;
    migrationError = "";
    migrationResult = null;
    try {
      migrationPreview = await selectedMigration.inspect();
    } catch (error) {
      migrationPreview = null;
      migrationError = error instanceof Error ? error.message : String(error);
    } finally {
      migrationBusy = false;
    }
  }

  async function runMigrationTask() {
    if (!selectedMigration || !migrationPreview || migrationPreview.ready === 0 || migrationBusy) return;
    if (!confirm(`将串行迁移 ${migrationPreview.ready} 个文档引用。建议先关闭包含旧引用的文档，并确保思源同步已完成。是否继续？`)) return;

    migrationBusy = true;
    migrationError = "";
    try {
      migrationResult = await selectedMigration.run(migrationPreview);
      migrationPreview = await selectedMigration.inspect();
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error);
    } finally {
      migrationBusy = false;
    }
  }
</script>

<div class="vault-shell">
  <aside class="vault-groups" aria-label="秘密分组">
    <div class="vault-brand-row">
      <div class="vault-brand">
        <span class="vault-brand-icon">🔐</span>
        <span>Secret Vault</span>
      </div>
      {#if workspaceSection === "vault"}
        <button
          class="vault-icon-button"
          title="新建分组"
          aria-label="新建分组"
          onclick={() => {
            showGroupCreator = !showGroupCreator;
            errorText = "";
          }}
        >+</button>
      {/if}
    </div>

    {#if workspaceSection === "vault"}
      {#if showGroupCreator}
        <section class="vault-inline-card vault-group-creator">
          <label>
            <span>分组名称</span>
            <input class="b3-text-field" bind:value={groupName} autocomplete="off" />
          </label>
          <label>
            <span>口令</span>
            <input
              class="b3-text-field"
              type="password"
              autocomplete="new-password"
              bind:value={groupPassword}
              onkeydown={(event) => {
                if (event.key === "Enter" && !busy) void createGroupInline();
              }}
            />
          </label>
          <div class="vault-inline-actions">
            <button class="vault-quiet-button" disabled={busy} onclick={() => showGroupCreator = false}>取消</button>
            <button class="b3-button b3-button--text" disabled={busy} onclick={createGroupInline}>创建</button>
          </div>
        </section>
      {/if}

      <nav class="vault-group-list">
        {#each snapshot.groups as group}
          <button
            class="vault-group"
            class:active={group.id === selectedGroupId}
            onclick={() => selectGroup(group.id)}
          >
            <span class="vault-group-name">{group.name}</span>
            <span class="vault-group-meta">
              <span>{group.secretCount}</span>
              <span class="vault-dot" aria-hidden="true">·</span>
              <span>{group.unlocked ? "已解锁" : group.initialized ? "已锁定" : "未设口令"}</span>
            </span>
          </button>
        {/each}
      </nav>

      <button class="vault-maintenance-entry" onclick={openMigrations}>
        <span>数据与迁移</span>
        <span aria-hidden="true">›</span>
      </button>
    {:else}
      <nav class="vault-migration-nav" aria-label="迁移任务">
        <div class="vault-nav-section-label">MAINTENANCE</div>
        {#each migrationTasks as task}
          <button
            class="vault-group"
            class:active={task.id === selectedMigrationId}
            onclick={() => selectMigration(task.id)}
          >
            <span class="vault-group-name">{task.title}</span>
            <span class="vault-group-meta">显式维护任务</span>
          </button>
        {:else}
          <div class="vault-empty-list">当前没有迁移任务</div>
        {/each}
      </nav>
      <button class="vault-maintenance-entry active" onclick={openVaultWorkspace}>
        <span aria-hidden="true">‹</span>
        <span>返回秘密库</span>
      </button>
    {/if}
  </aside>

  {#if workspaceSection === "vault"}
  <section class="vault-secrets" aria-label="秘密列表">
    {#if selectedGroup}
      <header class="vault-list-header">
        <div class="vault-list-title-row">
          <div>
            <h2>{selectedGroup.name}</h2>
            <span class:unlocked={selectedGroup.unlocked} class="vault-status-badge">
              {selectedGroup.unlocked ? "已解锁" : selectedGroup.initialized ? "已锁定" : "未设置口令"}
            </span>
          </div>
          <div class="vault-list-actions">
            {#if selectedGroup.unlocked}
              <button
                class="vault-icon-button"
                title="锁定当前秘密库上下文"
                aria-label="锁定当前秘密库上下文"
                onclick={() => vault.lockGroup(contextId, selectedGroup.id)}
              >🔒</button>
              <button
                class="vault-icon-button"
                title="修改分组口令"
                aria-label="修改分组口令"
                onclick={() => {
                  replacementPassword = "";
                  errorText = "";
                  showPasswordDialog = true;
                }}
              >⋯</button>
            {/if}
          </div>
        </div>

        {#if !selectedGroup.unlocked}
          <div class="vault-unlock-row">
            <input
              class="b3-text-field"
              type="password"
              autocomplete="current-password"
              bind:value={unlockPassword}
              placeholder={selectedGroup.initialized ? "输入分组口令" : "设置这个分组的口令"}
              onkeydown={(event) => {
                if (event.key === "Enter" && !busy) void unlockSelectedGroup();
              }}
            />
            <button class="b3-button b3-button--text" disabled={busy} onclick={unlockSelectedGroup}>
              {selectedGroup.initialized ? "解锁" : "设置"}
            </button>
          </div>
        {/if}

        <div class="vault-search-row">
          <input class="b3-text-field" bind:value={filter} placeholder="搜索 label" />
          <button
            class="vault-icon-button vault-add-secret"
            title="新建秘密"
            aria-label="新建秘密"
            disabled={!selectedGroup.unlocked}
            onclick={startCreateSecret}
          >+</button>
        </div>
      </header>

      <div class="vault-secret-list">
        {#each filteredSecrets as secret}
          <button
            class="vault-secret-row"
            class:active={secret.id === selectedSecretId && detailMode === "view"}
            onclick={() => selectSecret(secret)}
          >
            <span class="vault-secret-label">{secret.label}</span>
            <span class="vault-secret-chevron" aria-hidden="true">›</span>
          </button>
        {:else}
          <div class="vault-empty-list">
            {filter ? "没有匹配的秘密" : "这个分组还没有秘密"}
          </div>
        {/each}
      </div>

      {#if selectedGroup.id !== "default"}
        <footer class="vault-list-footer">
          <button class="vault-danger-link" onclick={removeSelectedGroup}>删除此分组</button>
        </footer>
      {/if}
    {/if}
  </section>

  <main class="vault-detail">
    {#if detailMode === "create" || detailMode === "edit"}
      <section class="vault-detail-panel">
        <header class="vault-detail-header">
          <div>
            <div class="vault-eyebrow">{detailMode === "create" ? "NEW SECRET" : "EDIT SECRET"}</div>
            <h1>{detailMode === "create" ? "新建秘密" : "编辑秘密"}</h1>
          </div>
        </header>

        <div class="vault-editor-form">
          <label>
            <span>Label</span>
            <input class="b3-text-field" bind:value={editorLabel} autocomplete="off" />
          </label>
          <label class="vault-editor-content-field">
            <span>Content</span>
            <textarea
              class="b3-text-field vault-detail-textarea"
              bind:value={editorContent}
              spellcheck="false"
            ></textarea>
          </label>
        </div>

        {#if errorText}
          <div class="vault-error">{errorText}</div>
        {/if}

        <footer class="vault-detail-actions">
          <button class="vault-quiet-button" disabled={busy} onclick={cancelEditor}>取消</button>
          <button class="b3-button b3-button--text" disabled={busy} onclick={saveEditor}>保存</button>
        </footer>
      </section>
    {:else if selectedSecret}
      <section class="vault-detail-panel">
        <header class="vault-detail-header">
          <div class="vault-detail-title">
            <div class="vault-eyebrow">{selectedGroup?.name}</div>
            <h1>{selectedSecret.label}</h1>
          </div>
          <div class="vault-detail-toolbar">
            <button class="vault-quiet-button" onclick={insertSelectedSecret}>插入文档</button>
            <button
              class="vault-quiet-button"
              disabled={!selectedGroup?.unlocked || busy}
              onclick={copySelectedSecret}
            >复制</button>
            <button
              class="b3-button b3-button--outline"
              disabled={!selectedGroup?.unlocked || busy}
              onclick={startEditSecret}
            >编辑</button>
          </div>
        </header>

        <section class="vault-content-section">
          <div class="vault-section-label">Content</div>
          {#if !selectedGroup?.unlocked}
            <div class="vault-locked-content">
              <span class="vault-lock-glyph">🔒</span>
              <div>
                <strong>此分组在秘密库中已锁定</strong>
                <p>在左侧输入分组口令后即可查看和编辑内容。文档中的授权与这里彼此独立。</p>
              </div>
            </div>
          {:else if detailLoading}
            <div class="vault-content-placeholder">正在解密…</div>
          {:else}
            <pre class="vault-content-view">{detailContent}</pre>
          {/if}
        </section>

        <section class="vault-metadata">
          <div class="vault-section-label">Metadata</div>
          <dl>
            <div>
              <dt>创建时间</dt>
              <dd>{formatTime(selectedSecret.createdAt)}</dd>
            </div>
            <div>
              <dt>最后更新</dt>
              <dd>{formatTime(selectedSecret.updatedAt)}</dd>
            </div>
          </dl>
        </section>

        {#if errorText}
          <div class="vault-error">{errorText}</div>
        {/if}

        <footer class="vault-detail-footer">
          <button
            class="vault-danger-link"
            disabled={!selectedGroup?.unlocked || busy}
            onclick={removeSelectedSecret}
          >删除秘密</button>
        </footer>
      </section>
    {:else}
      <div class="vault-detail-empty">
        <div class="vault-detail-empty-icon">🔐</div>
        <strong>选择一个秘密</strong>
        <span>或者在中间列表创建新的秘密。</span>
      </div>
    {/if}
  </main>
  {:else}
    <main class="vault-migration-workspace">
      {#if selectedMigration}
        <section class="vault-migration-panel">
          <header class="vault-migration-header">
            <div>
              <div class="vault-eyebrow">DATA & MIGRATIONS</div>
              <h1>{selectedMigration.title}</h1>
              <p>{selectedMigration.description}</p>
            </div>
            <button class="b3-button b3-button--outline" disabled={migrationBusy} onclick={inspectMigration}>
              {migrationBusy ? "处理中…" : migrationPreview ? "重新扫描" : "扫描旧版引用"}
            </button>
          </header>

          {#if migrationPreview}
            <section class="vault-migration-summary" aria-label="扫描结果">
              <div><strong>{migrationPreview.total}</strong><span>发现</span></div>
              <div><strong>{migrationPreview.ready}</strong><span>可迁移</span></div>
              <div class:warn={migrationPreview.issues > 0}><strong>{migrationPreview.issues}</strong><span>需要处理</span></div>
            </section>

            <div class="vault-migration-actions">
              <span>扫描只读，不会打开文档；迁移前建议关闭包含旧引用的文档。</span>
              <button
                class="b3-button b3-button--text"
                disabled={migrationBusy || migrationPreview.ready === 0}
                onclick={runMigrationTask}
              >开始迁移 {migrationPreview.ready > 0 ? `(${migrationPreview.ready})` : ""}</button>
            </div>

            <section class="vault-migration-items">
              {#each migrationPreview.items as item}
                <article class="vault-migration-item" class:issue={item.status === "issue"}>
                  <div class="vault-migration-item-main">
                    <div class="vault-migration-item-title">
                      <span class="vault-migration-status" aria-hidden="true">{item.status === "ready" ? "✓" : "!"}</span>
                      <strong>{item.label || item.secretId || "无法识别的引用"}</strong>
                    </div>
                    <span class="vault-migration-path">{item.documentPath}</span>
                    <span class="vault-migration-note">{item.note}</span>
                  </div>
                  <code class="vault-block-id" title="块 ID，可选中复制">{item.blockId}</code>
                </article>
              {:else}
                <div class="vault-migration-empty">没有发现需要迁移的旧版引用。</div>
              {/each}
            </section>
          {:else}
            <section class="vault-migration-intro">
              <strong>不会自动扫描或修改工作区</strong>
              <p>迁移中心是长期维护入口。升级插件不会触发文档扫描；扫描不会打开旧文档。只有你主动执行任务时，迁移器才会串行更新对应块。</p>
            </section>
          {/if}

          {#if migrationResult}
            <section class="vault-migration-result">
              <strong>本次迁移：{migrationResult.migrated} 已迁移，{migrationResult.skipped} 已跳过，{migrationResult.failed} 失败</strong>
              {#if migrationResult.failed > 0}
                <p>检测到失败后已停止后续写入。请检查失败项，再重新扫描。</p>
                <details>
                  <summary>查看失败项</summary>
                  <ul>
                    {#each migrationResult.items.filter((item) => !item.ok) as item}
                      <li><code>{item.blockId}</code> — {item.message}</li>
                    {/each}
                  </ul>
                </details>
              {/if}
            </section>
          {/if}

          {#if migrationError}
            <div class="vault-error">{migrationError}</div>
          {/if}

          <footer class="vault-migration-future">
            <span>未来的 Vault schema、引用格式或加密元数据迁移会继续放在这里。</span>
          </footer>
        </section>
      {:else}
        <div class="vault-detail-empty">当前没有迁移任务。</div>
      {/if}
    </main>
  {/if}
</div>

{#if showPasswordDialog}
  <div
    class="vault-modal-backdrop"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget && !busy) showPasswordDialog = false;
    }}
  >
    <section class="vault-modal vault-password-modal" role="dialog" aria-modal="true">
      <h3>修改 {selectedGroup?.name} 的口令</h3>
      <p class="vault-muted">
        这是少数保留为对话框的操作。修改后会撤销其他文档对这个分组的授权。
      </p>
      <label>
        <span>新口令</span>
        <input
          class="b3-text-field"
          type="password"
          autocomplete="new-password"
          bind:value={replacementPassword}
          onkeydown={(event) => {
            if (event.key === "Enter" && !busy) void changePassword();
          }}
        />
      </label>
      {#if errorText}<div class="vault-error">{errorText}</div>{/if}
      <footer>
        <button class="vault-quiet-button" disabled={busy} onclick={() => showPasswordDialog = false}>取消</button>
        <button class="b3-button b3-button--text" disabled={busy} onclick={changePassword}>确认修改</button>
      </footer>
    </section>
  </div>
{/if}
