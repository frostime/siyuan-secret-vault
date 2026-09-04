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
