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

<style>
  .vault-secrets {
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: hidden;
    flex-direction: column;
    border-right: 1px solid var(--b3-border-color);
    background: var(--b3-theme-background);
  }

  .vault-list-header {
    padding: 14px 12px 10px;
    border-bottom: 1px solid var(--b3-border-color);
  }

  .vault-list-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .vault-list-title-row > div:first-child {
    min-width: 0;
  }

  .vault-list-title-row h2 {
    display: inline;
    margin: 0;
    font-size: var(--sv-text-normal);
    font-weight: var(--sv-weight-strong);
  }

  .vault-status-badge {
    display: inline-flex;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: var(--sv-radius-pill);
    background: var(--b3-theme-surface, var(--b3-list-hover));
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-normal);
    opacity: .68;
    vertical-align: 1px;
  }

  .vault-status-badge.unlocked {
    color: var(--b3-theme-primary);
    opacity: 1;
  }

  .vault-list-actions {
    display: flex;
    gap: 2px;
  }

  .vault-search-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
  }

  .vault-search-row input {
    min-width: 0;
    flex: 1;
  }

  .vault-add-secret {
    flex: 0 0 auto;
  }

  .vault-secret-list {
    min-height: 0;
    overflow: auto;
    flex: 1;
    padding: 6px;
  }

  .vault-secret-row {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
    padding: 9px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .vault-secret-row:hover {
    background: var(--b3-list-hover);
  }

  .vault-secret-row.active {
    background: var(--b3-list-hover);
    box-shadow: inset 2px 0 0 var(--b3-theme-primary);
  }

  .vault-secret-row.selection-active {
    background: var(--b3-list-hover);
  }

  /* Multi-select is an explicit mode: the checkbox sits outside the row button
     (interactive content must not nest inside a button) and only takes layout
     space while the mode is active, so the normal list keeps its original
     layout with no leading placeholder. */
  .vault-secret-item {
    display: flex;
    align-items: center;
    position: relative;
  }

  .vault-secret-check {
    display: none;
  }

  .vault-secret-list.multi-active .vault-secret-check {
    display: block;
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    margin: 0 2px 0 5px;
    accent-color: var(--b3-theme-primary);
    cursor: pointer;
  }

  /* Single-secret quick move: an overlay button fades in over the chevron on
     row hover. It is absolutely positioned, so the normal row layout never
     shifts. Hidden while multi-select is active (rows then toggle selection). */
  .vault-secret-move {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    padding: 2px 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--b3-theme-primary);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .vault-secret-list:not(.multi-active) .vault-secret-item:hover .vault-secret-move {
    opacity: 1;
    pointer-events: auto;
  }

  .vault-secret-item:hover .vault-secret-chevron {
    opacity: 0;
  }

  .vault-select-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--b3-border-color);
    border-bottom: 1px solid var(--b3-border-color);
    background: color-mix(
      in srgb,
      var(--b3-theme-primary) 7%,
      transparent
    );
  }

  .vault-select-count {
    font-size: var(--sv-text-small);
    color: var(--b3-theme-primary);
  }

  .vault-select-spacer {
    flex: 1;
  }

  .vault-secret-label {
    min-width: 0;
    overflow: hidden;
    flex: 1;
    font-size: var(--sv-text-normal);
    font-weight: var(--sv-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vault-secret-chevron {
    font-size: 17px;
    opacity: .32;
  }

  .vault-list-footer {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--b3-border-color);
  }

  @media (max-width: 720px) {
    .vault-secrets {
      height: 280px;
      border-right: 0;
      border-bottom: 1px solid var(--b3-border-color);
    }
  }
</style>
