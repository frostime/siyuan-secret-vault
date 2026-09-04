<script lang="ts">
  import type { VaultWorkbench } from "./workbench.svelte";

  let { workbench } = $props<{ workbench: VaultWorkbench }>();
</script>

<main class="vault-detail">
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
          <div class="vault-locked-content">
            <span class="vault-lock-glyph">🔒</span>
            <div>
              <strong>此分组在秘密库中已锁定</strong>
              <p>在左侧输入分组口令后即可查看和编辑内容。文档中的授权与这里彼此独立。</p>
            </div>
          </div>
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
  {:else}
    <div class="vault-detail-empty">
      <div class="vault-detail-empty-icon">🔐</div>
      <strong>选择一个秘密</strong>
      <span>或者在中间列表创建新的秘密。</span>
    </div>
  {/if}
</main>
