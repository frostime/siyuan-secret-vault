<script lang="ts">
  import type { VaultWorkbench } from "./workbench.svelte";

  let { workbench } = $props<{ workbench: VaultWorkbench }>();
</script>

<section class="vault-secrets" aria-label="秘密列表">
  {#if workbench.selectedGroup}
    <header class="vault-list-header">
      <div class="vault-list-title-row">
        <div>
          <h2>{workbench.selectedGroup.name}</h2>
          <span class:unlocked={workbench.selectedGroup.unlocked} class="vault-status-badge">
            {workbench.selectedGroup.unlocked ? "已解锁" : workbench.selectedGroup.initialized ? "已锁定" : "未设置口令"}
          </span>
        </div>
        <div class="vault-list-actions">
          {#if workbench.selectedGroup.unlocked}
            <button
              class="vault-icon-button"
              title="锁定当前秘密库上下文"
              aria-label="锁定当前秘密库上下文"
              onclick={() => workbench.lockSelectedGroup()}
            >🔒</button>
            <button
              class="vault-icon-button"
              title="修改分组口令"
              aria-label="修改分组口令"
              onclick={() => {
                workbench.replacementPassword = "";
                workbench.errorText = "";
                workbench.showPasswordDialog = true;
              }}
            >⋯</button>
          {/if}
        </div>
      </div>

      {#if !workbench.selectedGroup.unlocked}
        <div class="vault-unlock-row">
          <input
            class="b3-text-field"
            type="password"
            autocomplete="current-password"
            bind:value={workbench.unlockPassword}
            placeholder={workbench.selectedGroup.initialized ? "输入分组口令" : "设置这个分组的口令"}
            onkeydown={(event) => {
              if (event.key === "Enter" && !workbench.busy) void workbench.unlockSelectedGroup();
            }}
          />
          <button class="b3-button b3-button--text" disabled={workbench.busy} onclick={() => workbench.unlockSelectedGroup()}>
            {workbench.selectedGroup.initialized ? "解锁" : "设置"}
          </button>
        </div>
      {/if}

      <div class="vault-search-row">
        <input class="b3-text-field" bind:value={workbench.filter} placeholder="搜索 label" />
        {#if !workbench.multiSelectMode}
          <button
            class="vault-quiet-button"
            title="多选"
            aria-label="多选"
            onclick={() => workbench.enterMultiSelect()}
          >多选</button>
        {/if}
        <button
          class="vault-icon-button vault-add-secret"
          title="新建秘密"
          aria-label="新建秘密"
          disabled={!workbench.selectedGroup.unlocked}
          onclick={() => workbench.startCreateSecret()}
        >+</button>
      </div>
    </header>

    {#if workbench.multiSelectMode}
      <div class="vault-select-bar" role="toolbar" aria-label="多选操作">
        <span class="vault-select-count">已选 {workbench.selectedSecretIds.length} 项</span>
        <span class="vault-select-spacer" aria-hidden="true"></span>
        <button
          class="b3-button b3-button--text"
          disabled={workbench.busy || workbench.selectedSecretIds.length === 0}
          onclick={() => workbench.openMoveDialogFromSelection()}
        >移动到…</button>
        <button class="vault-quiet-button" disabled={workbench.busy} onclick={() => workbench.exitMultiSelect()}>取消</button>
      </div>
    {/if}

    <div class="vault-secret-list" class:multi-active={workbench.multiSelectMode}>
      {#each workbench.filteredSecrets as secret}
        <div class="vault-secret-item">
          <input
            type="checkbox"
            class="vault-secret-check"
            aria-label={`选择 ${secret.label}`}
            checked={workbench.selectedSecretIds.includes(secret.id)}
            onclick={(event) => {
              event.stopPropagation();
              workbench.toggleSecretSelection(secret.id);
            }}
          />
          <button
            class="vault-secret-row"
            class:active={secret.id === workbench.selectedSecretId && workbench.detailMode === "view"}
            class:selection-active={workbench.selectedSecretIds.includes(secret.id)}
            onclick={() => {
              if (workbench.multiSelectMode) {
                workbench.toggleSecretSelection(secret.id);
              } else {
                workbench.selectSecret(secret);
              }
            }}
          >
            <span class="vault-secret-label">{secret.label}</span>
            <span class="vault-secret-chevron" aria-hidden="true">›</span>
          </button>
          <button
            class="vault-secret-move"
            title="移动到…"
            aria-label={`移动 ${secret.label} 到其他分组`}
            onclick={() => workbench.openMoveDialogForSecret(secret.id)}
          >⇄</button>
        </div>
      {:else}
        <div class="vault-empty-list">
          {workbench.filter ? "没有匹配的秘密" : "这个分组还没有秘密"}
        </div>
      {/each}
    </div>

    {#if workbench.selectedGroup.id !== "default"}
      <footer class="vault-list-footer">
        <button class="vault-danger-link" onclick={() => workbench.requestRemoveSelectedGroup()}>删除此分组</button>
      </footer>
    {/if}
  {/if}
</section>
