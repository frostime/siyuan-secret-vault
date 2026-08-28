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
