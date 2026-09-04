<script lang="ts">
  import type { VaultWorkbench } from "./workbench.svelte";

  let { workbench } = $props<{ workbench: VaultWorkbench }>();
</script>

<aside class="vault-groups" aria-label="秘密分组">
  <div class="vault-brand-row">
    <div class="vault-brand">
      <span class="vault-brand-icon">🔐</span>
      <span>Secret Vault</span>
    </div>
    {#if workbench.workspaceSection === "vault"}
      <button
        class="vault-icon-button"
        title="新建分组"
        aria-label="新建分组"
        onclick={() => {
          workbench.showGroupCreator = !workbench.showGroupCreator;
          workbench.errorText = "";
        }}
      >+</button>
    {/if}
  </div>

  {#if workbench.workspaceSection === "vault"}
    {#if workbench.showGroupCreator}
      <section class="vault-inline-card vault-group-creator">
        <label>
          <span>分组名称</span>
          <input class="b3-text-field" bind:value={workbench.groupName} autocomplete="off" />
        </label>
        <label>
          <span>口令</span>
          <input
            class="b3-text-field"
            type="password"
            autocomplete="new-password"
            bind:value={workbench.groupPassword}
            onkeydown={(event) => {
              if (event.key === "Enter" && !workbench.busy) void workbench.createGroupInline();
            }}
          />
        </label>
        <div class="vault-inline-actions">
          <button class="vault-quiet-button" disabled={workbench.busy} onclick={() => workbench.showGroupCreator = false}>取消</button>
          <button class="b3-button b3-button--text" disabled={workbench.busy} onclick={() => workbench.createGroupInline()}>创建</button>
        </div>
      </section>
    {/if}

    <nav class="vault-group-list">
      {#each workbench.snapshot.groups as group}
        <button
          class="vault-group"
          class:active={group.id === workbench.selectedGroupId}
          onclick={() => workbench.selectGroup(group.id)}
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

    <button class="vault-maintenance-entry" onclick={() => workbench.openMigrations()}>
      <span>数据与迁移</span>
      <span aria-hidden="true">›</span>
    </button>
  {:else}
    <nav class="vault-migration-nav" aria-label="迁移任务">
      <div class="vault-nav-section-label">MAINTENANCE</div>
      {#each workbench.migrationTasks as task}
        <button
          class="vault-group"
          class:active={task.id === workbench.selectedMigrationId}
          onclick={() => workbench.selectMigration(task.id)}
        >
          <span class="vault-group-name">{task.title}</span>
          <span class="vault-group-meta">显式维护任务</span>
        </button>
      {:else}
        <div class="vault-empty-list">当前没有迁移任务</div>
      {/each}
    </nav>
    <button class="vault-maintenance-entry active" onclick={() => workbench.openVaultWorkspace()}>
      <span aria-hidden="true">‹</span>
      <span>返回秘密库</span>
    </button>
  {/if}
</aside>

<style>
  .vault-groups {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 12px 10px;
    border-right: 1px solid var(--b3-border-color);
    background: color-mix(in srgb, var(--b3-theme-surface, var(--b3-theme-background)) 74%, var(--b3-theme-background));
    display: flex;
    flex-direction: column;
  }

  .vault-brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .vault-brand {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 7px;
    padding: 0 5px;
    font-size: var(--sv-text-normal);
    font-weight: var(--sv-weight-strong);
    letter-spacing: -.01em;
  }

  .vault-brand-icon {
    font-size: 14px;
  }

  .vault-group-list {
    display: flex;
    min-height: 0;
    overflow: auto;
    flex: 1;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    margin-top: 12px;
    padding: 1px 0 6px;
    overscroll-behavior: contain;
  }

  .vault-group {
    position: relative;
    display: grid;
    flex: 0 0 auto;
    gap: 2px;
    width: 100%;
    min-height: 44px;
    padding: 7px 9px 7px 12px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }

  .vault-group:hover {
    background: var(--b3-list-hover);
  }

  .vault-group.active {
    border-color: var(--sv-active-border);
    background: var(--sv-active-background);
  }

  .vault-group.active::before {
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 3px;
    width: 2px;
    border-radius: 999px;
    background: var(--b3-theme-primary);
    content: "";
  }

  .vault-group-name {
    overflow: hidden;
    font-size: var(--sv-text-normal);
    font-weight: var(--sv-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vault-group-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--b3-theme-on-surface, var(--b3-theme-on-background));
    font-size: var(--sv-text-small);
    opacity: .58;
  }

  .vault-dot {
    opacity: .45;
  }

  .vault-inline-card {
    margin-top: 10px;
    padding: 9px;
    border: var(--sv-border);
    border-radius: var(--sv-radius-normal);
    background: var(--b3-theme-background);
  }

  .vault-group-creator {
    display: grid;
    gap: 8px;
  }

  /* Text fields carry an intrinsic width that would otherwise stretch the
     creator card past the narrow groups column; force them to the card width. */
  .vault-group-creator .b3-text-field {
    width: 100%;
    min-width: 0;
  }

  .vault-group-creator label {
    display: grid;
    gap: 5px;
    font-size: var(--sv-text-small);
  }

  .vault-inline-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }

  .vault-migration-nav {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    min-height: 0;
    overflow: auto;
    margin-top: 14px;
    overscroll-behavior: contain;
  }

  .vault-nav-section-label {
    padding: 4px 9px 6px;
    font-size: var(--sv-text-small);
    font-weight: var(--sv-weight-strong);
    letter-spacing: .09em;
    opacity: .42;
  }

  .vault-maintenance-entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    margin-top: 10px;
    padding: 8px 9px;
    border: 0;
    border-top: 1px solid var(--b3-border-color);
    border-radius: 0 0 6px 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: var(--sv-text-small);
    opacity: .68;
  }

  .vault-maintenance-entry:hover,
  .vault-maintenance-entry.active {
    background: var(--b3-list-hover);
    opacity: 1;
  }

  @media (max-width: 720px) {
    .vault-groups {
      overflow: visible;
      border-right: 0;
      border-bottom: 1px solid var(--b3-border-color);
    }

    .vault-group-list {
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 3px;
    }

    .vault-group {
      width: auto;
      min-width: 116px;
      flex: 0 0 auto;
    }
  }
</style>
