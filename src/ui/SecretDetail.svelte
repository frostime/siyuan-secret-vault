<script lang="ts">
  import type { VaultWorkbench } from "./workbench.svelte";

  let { workbench } = $props<{ workbench: VaultWorkbench }>();
</script>

<main class="vault-detail">
  {#snippet unlockPanel()}
    {@const group = workbench.selectedGroup}
    <div class="vault-unlock-panel">
      <div class="vault-unlock-head">
        <span class="vault-lock-glyph">🔒</span>
        <div>
          <strong>
            {group.initialized ? `分组「${group.name}」已锁定` : `分组「${group.name}」未设置口令`}
          </strong>
          <p>
            {group.initialized
              ? "输入分组口令后即可查看和编辑此分组的秘密内容。"
              : "设置分组口令后即可加密和查看此分组的秘密内容。"}
          </p>
        </div>
      </div>
      <div class="vault-unlock-field">
        <input
          class="b3-text-field"
          type="password"
          autocomplete={group.initialized ? "current-password" : "new-password"}
          bind:value={workbench.unlockPassword}
          placeholder={group.initialized ? "输入分组口令" : "设置这个分组的口令"}
          onkeydown={(event) => {
            if (event.key === "Enter" && !workbench.busy) void workbench.unlockSelectedGroup();
          }}
        />
        <button class="b3-button b3-button--text" disabled={workbench.busy} onclick={() => workbench.unlockSelectedGroup()}>
          {group.initialized ? "解锁" : "设置"}
        </button>
      </div>
      <p class="vault-unlock-hint">口令仅保存在内存中，15 分钟无操作后自动重新锁定。文档中的授权与这里彼此独立。</p>
    </div>
  {/snippet}
  {#if workbench.detailMode === "create" || workbench.detailMode === "edit"}
    <section class="vault-detail-panel">
      <header class="vault-detail-header">
        <div>
          <div class="vault-eyebrow">{workbench.detailMode === "create" ? "NEW SECRET" : "EDIT SECRET"}</div>
          <h1>{workbench.detailMode === "create" ? "新建秘密" : "编辑秘密"}</h1>
        </div>
      </header>

      <div class="vault-editor-form">
        <label>
          <span>Label</span>
          <input class="b3-text-field" bind:value={workbench.editorLabel} autocomplete="off" />
        </label>
        <label class="vault-editor-content-field">
          <span>Content</span>
          <textarea
            class="b3-text-field vault-detail-textarea"
            bind:value={workbench.editorContent}
            spellcheck="false"
          ></textarea>
        </label>
      </div>

      {#if workbench.errorText}
        <div class="vault-error">{workbench.errorText}</div>
      {/if}

      <footer class="vault-detail-actions">
        <button class="vault-quiet-button" disabled={workbench.busy} onclick={() => workbench.cancelEditor()}>取消</button>
        <button class="b3-button b3-button--text" disabled={workbench.busy} onclick={() => workbench.saveEditor()}>保存</button>
      </footer>
    </section>
  {:else if workbench.selectedSecret}
    <section class="vault-detail-panel">
      <header class="vault-detail-header">
        <div class="vault-detail-title">
          <div class="vault-eyebrow">{workbench.selectedGroup?.name}</div>
          <h1>{workbench.selectedSecret.label}</h1>
        </div>
        <div class="vault-detail-toolbar">
          <button
            class="b3-button b3-button--outline"
            disabled={!workbench.selectedGroup?.unlocked || workbench.busy}
            onclick={() => workbench.startEditSecret()}
          >编辑</button>

          <button
            class="vault-quiet-button"
            disabled={!workbench.selectedGroup?.unlocked || workbench.busy}
            onclick={() => workbench.copySelectedSecret()}
          >复制内容</button>

          <button
            class="vault-quiet-button"
            disabled={workbench.busy}
            onclick={() => workbench.copySelectedSecretReference()}
          >复制为文档块</button>

          <button
            class="vault-quiet-button vault-move-button"
            disabled={workbench.busy}
            onclick={() => workbench.openMoveDialogForSecret(workbench.selectedSecret!.id)}
          >移动到…</button>

          <button
            class="vault-danger-link vault-detail-delete"
            disabled={!workbench.selectedGroup?.unlocked || workbench.busy}
            onclick={() => workbench.requestRemoveSelectedSecret()}
          >删除</button>
        </div>
      </header>

      <section class="vault-content-section">
        <div class="vault-section-label">Content</div>
        {#if !workbench.selectedGroup?.unlocked}
          {@render unlockPanel()}
        {:else if workbench.detailLoading}
          <div class="vault-content-placeholder">正在解密…</div>
        {:else}
          <pre class="vault-content-view">{workbench.detailContent}</pre>
        {/if}
      </section>

      <section class="vault-metadata">
        <div class="vault-section-label">Metadata</div>
        <dl>
          <div>
            <dt>创建时间</dt>
            <dd>{workbench.formatTime(workbench.selectedSecret.createdAt)}</dd>
          </div>
          <div>
            <dt>最后更新</dt>
            <dd>{workbench.formatTime(workbench.selectedSecret.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      {#if workbench.errorText}
        <div class="vault-error">{workbench.errorText}</div>
      {/if}
    </section>
  {:else if workbench.selectedGroup && !workbench.selectedGroup.unlocked}
    <section class="vault-detail-panel">
      {@render unlockPanel()}
      {#if workbench.errorText}
        <div class="vault-error">{workbench.errorText}</div>
      {/if}
    </section>
  {:else}
    <div class="vault-detail-empty">
      <div class="vault-detail-empty-icon">🔐</div>
      <strong>选择一个秘密</strong>
      <span>或者在中间列表创建新的秘密。</span>
    </div>
  {/if}
</main>

<style>
  .vault-detail {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background: var(--b3-theme-background);
  }

  .vault-detail-panel {
    display: flex;
    min-height: 100%;
    flex-direction: column;
    padding: clamp(18px, 3vw, 34px);
  }

  .vault-detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--b3-border-color);
  }

  .vault-detail-title {
    min-width: 0;
  }

  .vault-detail-header h1 {
    margin: 4px 0 0;
    overflow-wrap: anywhere;
    font-size: var(--sv-text-large);
    font-weight: var(--sv-weight-strong);
    letter-spacing: -.025em;
  }

  .vault-detail-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 4px;
  }

  .vault-detail-delete {
    margin-left: 5px;
    padding: 5px 8px;
    border-radius: 6px;
  }

  .vault-detail-delete:not(:disabled):hover {
    background: color-mix(
      in srgb,
      var(--b3-card-error-color, #c33) 9%,
      transparent
    );
    text-decoration: none;
  }

  .vault-move-button {
    color: var(--b3-theme-primary);
  }

  .vault-content-section,
  .vault-metadata {
    margin-top: 22px;
  }

  .vault-content-view,
  .vault-content-placeholder {
    margin: 8px 0 0;
    border: var(--sv-border);
    border-radius: var(--sv-radius-normal);
    background: var(--sv-surface-soft);
  }

  .vault-content-view {
    min-height: 132px;
    max-height: min(46vh, 480px);
    overflow: auto;
    padding: 13px 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      var(--sv-text-normal) /
      var(--sv-leading-relaxed)
      var(--b3-font-family-code);
  }

  /* SiYuan's .layout-tab-container sets user-select: none, which would make
     the vault contents unselectable; restore selection for the content area.
     The scoped class keeps specificity above the global tab rule. */
  .vault-content-view {
    user-select: text;
    -webkit-user-select: text;
  }

  .vault-content-placeholder {
    padding: 30px 14px;
    text-align: center;
    font-size: var(--sv-text-small);
    opacity: .55;
  }

  /* Locked groups render this panel in place of the secret content. It is the
     only unlock affordance since the list header no longer holds an input. */
  .vault-unlock-panel {
    margin: 8px 0 0;
    border: var(--sv-border);
    border-radius: var(--sv-radius-normal);
    background: var(--sv-surface-soft);
    padding: 14px;
  }

  .vault-unlock-head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .vault-lock-glyph {
    margin-top: 1px;
  }

  .vault-unlock-head strong {
    font-size: var(--sv-text-normal);
  }

  .vault-unlock-head p {
    max-width: 560px;
    margin: 4px 0 0;
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-relaxed);
    opacity: .58;
  }

  .vault-unlock-field {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
  }

  .vault-unlock-field input {
    flex: 1;
    min-width: 0;
  }

  .vault-unlock-hint {
    margin: 10px 0 0;
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-relaxed);
    opacity: .45;
  }

  .vault-metadata dl {
    display: grid;
    gap: 0;
    max-width: 560px;
    margin: 8px 0 0;
  }

  .vault-metadata dl > div {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 14px;
    padding: 8px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--b3-border-color) 68%, transparent);
  }

  .vault-metadata dt,
  .vault-metadata dd {
    margin: 0;
    font-size: var(--sv-text-small);
  }

  .vault-metadata dt {
    opacity: .52;
  }

  .vault-metadata dd {
    font-variant-numeric: tabular-nums;
  }

  .vault-detail-empty-icon {
    margin-bottom: 4px;
    font-size: 24px;
  }

  .vault-detail-empty span {
    font-size: var(--sv-text-small);
  }

  .vault-editor-form {
    display: grid;
    gap: 14px;
    margin-top: 20px;
  }

  .vault-editor-content-field {
    min-height: 0;
  }

  .vault-detail-textarea {
    min-height: 260px;
    resize: vertical;
    font-family: var(--b3-font-family-code);
    line-height: 1.5;
  }

  .vault-editor-form label {
    display: grid;
    gap: 5px;
    font-size: var(--sv-text-small);
  }

  .vault-detail-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 14px;
  }

  @media (max-width: 920px) {
    .vault-detail-panel {
      padding: 20px;
    }

    .vault-detail-header {
      align-items: stretch;
      flex-direction: column;
    }

    .vault-detail-toolbar {
      justify-content: flex-start;
    }
  }

  @media (max-width: 720px) {
    .vault-detail {
      min-height: 420px;
    }

    .vault-metadata dl > div {
      grid-template-columns: 92px minmax(0, 1fr);
    }
  }
</style>
