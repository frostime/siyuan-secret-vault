<script lang="ts">
  import type { SecretViewState } from "../types";

  interface SaveResult {
    state: SecretViewState;
    snapshotWarning?: string;
  }

  let {
    initialState,
    groupInitialized,
    unlock,
    save,
    copy,
    lock,
    close,
  } = $props<{
    initialState: SecretViewState;
    groupInitialized: boolean;
    unlock: (password: string) => Promise<SecretViewState>;
    save: (label: string, content: string) => Promise<SaveResult>;
    copy: () => Promise<void>;
    lock: () => void;
    close: () => void;
  }>();

  let state = $state(initialState);
  let password = $state("");
  let editing = $state(false);
  let labelDraft = $state(initialState.label);
  let contentDraft = $state(initialState.content ?? "");
  let busy = $state(false);
  let errorText = $state("");
  let noticeText = $state("");

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    errorText = "";
    noticeText = "";
    try {
      await action();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  function beginEdit(): void {
    if (state.locked) return;
    labelDraft = state.label;
    contentDraft = state.content ?? "";
    editing = true;
    errorText = "";
    noticeText = "";
  }

  function cancelEdit(): void {
    editing = false;
    labelDraft = state.label;
    contentDraft = state.content ?? "";
    errorText = "";
  }

  function submitUnlock(): void {
    void run(async () => {
      if (!password) throw new Error("口令不能为空");
      state = await unlock(password);
      password = "";
      labelDraft = state.label;
      contentDraft = state.content ?? "";
    });
  }

  function submitSave(): void {
    void run(async () => {
      const result = await save(labelDraft, contentDraft);
      state = result.state;
      labelDraft = state.label;
      contentDraft = state.content ?? "";
      editing = false;
      if (result.snapshotWarning) noticeText = result.snapshotWarning;
    });
  }

  function copySecret(): void {
    void run(async () => {
      await copy();
      noticeText = "已复制";
    });
  }
</script>

<section class="secret-popover-panel" aria-label="Secret Vault">
  <header class="secret-popover-header">
    <div class="secret-popover-identity">
      <strong>{state.label}</strong>
      <span>{state.groupName}</span>
    </div>
    <div class="secret-popover-header-actions">
      <span class="secret-popover-state" title={state.locked ? "已锁定" : "已解锁"}>
        {state.locked ? "🔒" : "🔓"}
      </span>
      <button class="b3-button b3-button--outline secret-popover-close" type="button" onclick={close} aria-label="关闭">×</button>
    </div>
  </header>

  {#if state.locked}
    <form class="secret-popover-unlock" onsubmit={(event) => { event.preventDefault(); submitUnlock(); }}>
      <p>{groupInitialized ? "输入该分组口令以在当前文档中解锁。" : "该分组尚未设置口令；首次输入将成为分组口令。"}</p>
      <div class="secret-popover-inline-row">
        <input
          class="b3-text-field fn__flex-1"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          placeholder="分组口令"
          disabled={busy}
        />
        <button class="b3-button b3-button--text" type="submit" disabled={busy}>解锁</button>
      </div>
    </form>
  {:else if editing}
    <div class="secret-popover-editor">
      <input class="b3-text-field fn__block" bind:value={labelDraft} disabled={busy} aria-label="Label" />
      <textarea
        class="b3-text-field fn__block secret-popover-textarea"
        bind:value={contentDraft}
        disabled={busy}
        spellcheck="false"
        aria-label="Secret content"
        onkeydown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submitSave();
          }
        }}
      ></textarea>
      <div class="secret-popover-actions secret-popover-actions--end">
        <button class="b3-button b3-button--cancel" type="button" onclick={cancelEdit} disabled={busy}>取消</button>
        <button class="b3-button b3-button--text" type="button" onclick={submitSave} disabled={busy}>保存</button>
      </div>
    </div>
  {:else}
    <pre class="secret-popover-content">{state.content ?? ""}</pre>
    <div class="secret-popover-actions">
      <button class="b3-button b3-button--outline" type="button" onclick={beginEdit} disabled={busy}>编辑</button>
      <button class="b3-button b3-button--outline" type="button" onclick={copySecret} disabled={busy}>复制</button>
      <button class="b3-button b3-button--outline" type="button" onclick={lock} disabled={busy}>锁定分组</button>
    </div>
  {/if}

  {#if errorText}
    <div class="secret-popover-message secret-popover-message--error">{errorText}</div>
  {:else if noticeText}
    <div class="secret-popover-message">{noticeText}</div>
  {/if}
</section>

<style>
  /* Host is created by secret-interaction.ts (outside this component). */
  :global(.secret-vault-popover-root) {
    position: fixed;
    z-index: 211;
    box-sizing: border-box;
    max-width: calc(100vw - 20px);
    max-height: calc(100vh - 20px);
    overflow: auto;
    border: var(--sv-border);
    border-radius: var(--sv-radius-large);
    background: var(--b3-theme-background);
    color: var(--b3-theme-on-background);
    box-shadow: var(--b3-dialog-shadow);
    font-family: var(--b3-font-family);
    font-size: var(--sv-text-normal);
  }

  .secret-popover-panel {
    padding: 11px;
  }

  .secret-popover-header,
  .secret-popover-header-actions,
  .secret-popover-inline-row,
  .secret-popover-actions {
    display: flex;
    align-items: center;
  }

  .secret-popover-header {
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 9px;
  }

  .secret-popover-identity {
    min-width: 0;
  }

  .secret-popover-identity strong {
    display: block;
    overflow: hidden;
    font-size: var(--sv-text-normal);
    line-height: var(--sv-leading-tight);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .secret-popover-identity span {
    display: block;
    margin-top: 2px;
    color: var(--b3-theme-on-surface);
    font-size: var(--sv-text-small);
  }

  .secret-popover-header-actions {
    flex: 0 0 auto;
    gap: 6px;
  }

  .secret-popover-state {
    font-size: var(--sv-text-normal);
  }

  .secret-popover-close {
    min-width: 28px;
    padding: 2px 7px;
    font-size: 17px;
    line-height: 1.2;
  }

  .secret-popover-unlock p {
    margin: 2px 0 9px;
    color: var(--b3-theme-on-surface);
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-normal);
  }

  .secret-popover-inline-row {
    gap: 7px;
  }

  .secret-popover-content {
    box-sizing: border-box;
    min-height: 78px;
    max-height: min(320px, 45vh);
    margin: 0 0 8px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: var(--sv-border);
    border-radius: var(--sv-radius-small);
    background: var(--b3-theme-surface);
    padding: 8px 9px;
    font:
      var(--sv-text-normal) /
      var(--sv-leading-normal)
      var(--b3-font-family-code);
  }

  .secret-popover-editor {
    display: grid;
    gap: 7px;
  }

  .secret-popover-textarea {
    min-height: 140px;
    max-height: 45vh;
    resize: vertical;
    font:
      var(--sv-text-normal) /
      var(--sv-leading-normal)
      var(--b3-font-family-code);
  }

  .secret-popover-actions {
    flex-wrap: wrap;
    gap: 6px;
  }

  .secret-popover-actions--end {
    justify-content: flex-end;
  }

  .secret-popover-message {
    margin-top: 8px;
    color: var(--b3-theme-on-surface);
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-tight);
  }

  .secret-popover-message--error {
    color: var(--sv-danger-color);
  }
</style>
