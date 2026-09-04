<script lang="ts">
  import { onMount } from "svelte";
  import type { AccessContextId } from "../types";
  import type { VaultController } from "../vault";
  import type { MigrationTask } from "../migrations/types";
  import { VaultWorkbench } from "./workbench.svelte";
  import GroupSidebar from "./GroupSidebar.svelte";
  import SecretList from "./SecretList.svelte";
  import SecretDetail from "./SecretDetail.svelte";
  import MigrationWorkspace from "./MigrationWorkspace.svelte";
  import Modal from "./Modal.svelte";

  let {
    vault,
    contextId,
    copySecretReference,
    migrationTasks,
  } = $props<{
    vault: VaultController;
    contextId: AccessContextId;
    copySecretReference: (secretId: string) => Promise<void>;
    migrationTasks: MigrationTask[];
  }>();

  // The workbench binds these props once at mount: the tab host provides
  // stable references for the whole tab lifetime (index.ts), so capturing
  // the initial values is the intended initialization contract.
  const workbench = new VaultWorkbench(vault, contextId, copySecretReference, migrationTasks);

  onMount(() => workbench.mount());
</script>

<div class="vault-shell">
  <GroupSidebar {workbench} />
  {#if workbench.workspaceSection === "vault"}
    <SecretList {workbench} />
    <SecretDetail {workbench} />
  {:else}
    <MigrationWorkspace {workbench} />
  {/if}
</div>

{#if workbench.showMoveDialog}
  <Modal
    title={`移动 ${workbench.pendingMoveIds.length} 个秘密`}
    muted={`从「${workbench.selectedGroup?.name}」移动到目标分组。秘密 ID 不变，文档引用继续有效。`}
    busy={workbench.busy}
    onBackdrop={() => workbench.closeMoveDialog()}
  >
    <label>
      <span>目标分组</span>
      <div class="vault-move-targets">
        {#each workbench.moveTargets as target}
          <button
            class="vault-move-target"
            class:selected={target.id === workbench.moveTargetGroupId}
            onclick={() => workbench.selectMoveTarget(target.id)}
          >
            <span>{target.name}</span>
            <span class="vault-move-target-meta">
              {target.unlocked ? "已解锁" : target.initialized ? "已锁定 · 需要口令" : "未设口令 · 需要设置"}
            </span>
          </button>
        {:else}
          <div class="vault-empty-list">没有可移动到的分组</div>
        {/each}
      </div>
    </label>

    {#if workbench.selectedGroup && !workbench.selectedGroup.unlocked}
      <label>
        <span>源分组口令（{workbench.selectedGroup.name}）</span>
        <input
          class="b3-text-field"
          type="password"
          autocomplete="new-password"
          bind:value={workbench.moveSourcePassword}
          placeholder="输入源分组口令以解密"
        />
      </label>
    {/if}

    {#if workbench.moveTargetGroup && !workbench.moveTargetGroup.unlocked}
      <label>
        <span>目标分组口令（{workbench.moveTargetGroup.name}）</span>
        <input
          class="b3-text-field"
          type="password"
          autocomplete="new-password"
          bind:value={workbench.moveTargetPassword}
          placeholder="输入目标分组口令以加密"
        />
      </label>
    {/if}

    {#if workbench.moveError}
      <div class="vault-error">{workbench.moveError}</div>
    {/if}

    <footer>
      <button class="vault-quiet-button" disabled={workbench.busy} onclick={() => workbench.closeMoveDialog()}>取消</button>
      <button
        class="b3-button b3-button--text"
        disabled={workbench.busy || workbench.pendingMoveIds.length === 0}
        onclick={() => workbench.confirmMove()}
      >移动</button>
    </footer>
  </Modal>
{/if}

{#if workbench.confirmRequest}
  <Modal
    title={workbench.confirmRequest.title}
    muted={workbench.confirmRequest.message}
    busy={workbench.confirmBusy}
    onBackdrop={() => workbench.cancelConfirm()}
  >
    {#if workbench.confirmError}
      <div class="vault-error">{workbench.confirmError}</div>
    {/if}
    <footer>
      <button class="vault-quiet-button" disabled={workbench.confirmBusy} onclick={() => workbench.cancelConfirm()}>取消</button>
      <button
        class="b3-button b3-button--text"
        class:vault-confirm-danger={workbench.confirmRequest.danger}
        disabled={workbench.confirmBusy}
        onclick={() => workbench.runConfirm()}
      >{workbench.confirmRequest.confirmLabel}</button>
    </footer>
  </Modal>
{/if}

{#if workbench.showPasswordDialog}
  <Modal
    title={`修改 ${workbench.selectedGroup?.name} 的口令`}
    muted="这是少数保留为对话框的操作。修改后会撤销其他文档对这个分组的授权。"
    busy={workbench.busy}
    onBackdrop={() => workbench.showPasswordDialog = false}
  >
    <label>
      <span>新口令</span>
      <input
        class="b3-text-field"
        type="password"
        autocomplete="new-password"
        bind:value={workbench.replacementPassword}
        onkeydown={(event) => {
          if (event.key === "Enter" && !workbench.busy) void workbench.changePassword();
        }}
      />
    </label>
    {#if workbench.errorText}<div class="vault-error">{workbench.errorText}</div>{/if}
    <footer>
      <button class="vault-quiet-button" disabled={workbench.busy} onclick={() => workbench.showPasswordDialog = false}>取消</button>
      <button class="b3-button b3-button--text" disabled={workbench.busy} onclick={() => workbench.changePassword()}>确认修改</button>
    </footer>
  </Modal>
{/if}

<style>
  /* Tab host is created by index.ts (outside this component). */
  :global(.secret-vault-tab) {
    height: 100%;
    overflow: hidden;
    background: var(--b3-theme-background);
    color: var(--b3-theme-on-background);
    font-family: var(--b3-font-family);
    font-size: var(--sv-text-normal);
  }

  .vault-shell {
    display: grid;
    grid-template-columns: 204px minmax(260px, 320px) minmax(0, 1fr);
    height: 100%;
    min-height: 420px;
    background: var(--b3-theme-background);
  }

  /* Labels and footers live in the dialog children (rendered here, not in
     Modal), so their styles belong to this component. The .vault-modal
     ancestor is scoped to Modal, hence :global on the full selector. */
  :global(.vault-modal label) {
    display: grid;
    gap: 5px;
    margin-top: 14px;
    font-size: var(--sv-text-small);
  }

  :global(.vault-modal footer) {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 16px;
  }

  .vault-move-targets {
    display: grid;
    gap: 6px;
    margin-top: 6px;
  }

  .vault-move-target {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--b3-border-color);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .vault-move-target:hover {
    border-color: var(--b3-theme-primary);
  }

  .vault-move-target.selected {
    border-color: var(--b3-theme-primary);
    background: color-mix(
      in srgb,
      var(--b3-theme-primary) 9%,
      transparent
    );
  }

  .vault-move-target-meta {
    margin-left: auto;
    font-size: var(--sv-text-small);
    opacity: .55;
  }

  .vault-confirm-danger {
    color: var(--b3-card-error-color, #c33);
  }

  @media (max-width: 920px) {
    .vault-shell {
      grid-template-columns: 174px 250px minmax(0, 1fr);
    }
  }

  @media (max-width: 720px) {
    :global(.secret-vault-tab) {
      overflow: auto;
    }

    .vault-shell {
      display: block;
      height: auto;
      min-height: 100%;
    }
  }
</style>
