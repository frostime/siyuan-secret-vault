<script lang="ts">
  import type { VaultWorkbench } from "./workbench.svelte";

  let { workbench } = $props<{ workbench: VaultWorkbench }>();
</script>

<main class="vault-migration-workspace">
  {#if workbench.selectedMigration}
    <section class="vault-migration-panel">
      <header class="vault-migration-header">
        <div>
          <div class="vault-eyebrow">DATA & MIGRATIONS</div>
          <h1>{workbench.selectedMigration.title}</h1>
          <p>{workbench.selectedMigration.description}</p>
        </div>
        <button class="b3-button b3-button--outline" disabled={workbench.migrationBusy} onclick={() => workbench.inspectMigration()}>
          {workbench.migrationBusy ? "处理中…" : workbench.migrationPreview ? "重新扫描" : "扫描任务"}
        </button>
      </header>

      {#if workbench.migrationPreview}
        <section class="vault-migration-summary" aria-label="扫描结果">
          <div><strong>{workbench.migrationPreview.total}</strong><span>发现</span></div>
          <div><strong>{workbench.migrationPreview.ready}</strong><span>可处理</span></div>
          <div class:warn={workbench.migrationPreview.issues > 0}><strong>{workbench.migrationPreview.issues}</strong><span>需要处理</span></div>
        </section>

        <div class="vault-migration-actions">
          <span>扫描只读，不会打开文档；执行前建议关闭相关文档。</span>
          <button
            class="b3-button b3-button--text"
            disabled={workbench.migrationBusy || workbench.migrationPreview.ready === 0}
            onclick={() => workbench.requestRunMigration()}
          >开始执行 {workbench.migrationPreview.ready > 0 ? `(${workbench.migrationPreview.ready})` : ""}</button>
        </div>

        <section class="vault-migration-items">
          {#each workbench.migrationPreview.items as item}
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
            <div class="vault-migration-empty">没有发现需要处理的引用。</div>
          {/each}
        </section>
      {:else}
        <section class="vault-migration-intro">
          <strong>不会自动扫描或修改工作区</strong>
          <p>迁移中心是长期维护入口。升级插件不会触发文档扫描；扫描不会打开旧文档。只有你主动执行任务时，迁移器才会串行更新对应块。</p>
        </section>
      {/if}

      {#if workbench.migrationResult}
        <section class="vault-migration-result">
          <strong>本次迁移：{workbench.migrationResult.migrated} 已迁移，{workbench.migrationResult.skipped} 已跳过，{workbench.migrationResult.failed} 失败</strong>
          {#if workbench.migrationResult.failed > 0}
            <p>检测到失败后已停止后续写入。请检查失败项，再重新扫描。</p>
            <details>
              <summary>查看失败项</summary>
              <ul>
                {#each workbench.migrationFailedItems as item}
                  <li><code>{item.blockId}</code> — {item.message}</li>
                {/each}
              </ul>
            </details>
          {/if}
        </section>
      {/if}

      {#if workbench.migrationError}
        <div class="vault-error">{workbench.migrationError}</div>
      {/if}

      <footer class="vault-migration-future">
        <span>未来的 Vault schema、引用格式或加密元数据迁移会继续放在这里。</span>
      </footer>
    </section>
  {:else}
    <div class="vault-detail-empty">当前没有迁移任务。</div>
  {/if}
</main>

<style>
  .vault-migration-workspace {
    grid-column: 2 / 4;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background: var(--b3-theme-background);
  }

  .vault-migration-panel {
    width: min(920px, 100%);
    margin: 0 auto;
    padding: clamp(20px, 4vw, 42px);
  }

  .vault-migration-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 22px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--b3-border-color);
  }

  .vault-migration-header > div {
    min-width: 0;
  }

  .vault-migration-header h1 {
    margin: 5px 0 0;
    font-size: var(--sv-text-large);
    font-weight: var(--sv-weight-strong);
    letter-spacing: -.025em;
  }

  .vault-migration-header p {
    max-width: 650px;
    margin: 8px 0 0;
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-relaxed);
    opacity: .6;
  }

  .vault-migration-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 20px;
  }

  .vault-migration-summary > div {
    display: grid;
    gap: 2px;
    padding: 12px 14px;
    border: 1px solid var(--b3-border-color);
    border-radius: 8px;
    background: color-mix(in srgb, var(--b3-theme-surface, var(--b3-theme-background)) 52%, var(--b3-theme-background));
  }

  .vault-migration-summary strong {
    font-size: var(--sv-text-large);
    font-weight: var(--sv-weight-strong);
    font-variant-numeric: tabular-nums;
  }

  .vault-migration-summary span {
    font-size: var(--sv-text-small);
    opacity: .5;
  }

  .vault-migration-summary .warn strong {
    color: var(--sv-danger-color);
  }

  .vault-migration-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 12px;
    padding: 8px 0 12px;
    border-bottom: 1px solid var(--b3-border-color);
  }

  .vault-migration-actions > span {
    font-size: var(--sv-text-small);
    opacity: .5;
  }

  .vault-migration-items {
    display: grid;
    gap: 1px;
    margin-top: 8px;
    border: 1px solid var(--b3-border-color);
    border-radius: 8px;
    overflow: hidden;
  }

  .vault-migration-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 11px 12px;
    background: var(--b3-theme-background);
    border-bottom: 1px solid color-mix(in srgb, var(--b3-border-color) 70%, transparent);
  }

  .vault-migration-item:last-child {
    border-bottom: 0;
  }

  .vault-migration-item.issue {
    background: color-mix(in srgb, var(--b3-card-error-background, rgba(200,0,0,.06)) 48%, var(--b3-theme-background));
  }

  .vault-migration-item-main {
    display: grid;
    min-width: 0;
    gap: 3px;
  }

  .vault-migration-item-title {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: var(--sv-text-normal);
  }

  .vault-migration-item-title strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vault-migration-status {
    display: inline-grid;
    width: 17px;
    height: 17px;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--b3-list-hover);
    font-size: 10px;
  }

  .vault-migration-item.issue .vault-migration-status {
    color: var(--b3-card-error-color, #c33);
  }

  .vault-migration-path,
  .vault-migration-note {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--sv-text-small);
    opacity: .48;
  }

  .vault-migration-note {
    opacity: .62;
  }

  .vault-block-id {
    flex: 0 0 auto;
    padding: 4px 7px;
    border-radius: var(--sv-radius-small);
    color: inherit;
    text-decoration: none;
    font-size: var(--sv-text-small);
    opacity: .54;
  }

  .vault-migration-empty,
  .vault-migration-intro,
  .vault-migration-result {
    margin-top: 18px;
    padding: 16px;
    border: var(--sv-border);
    border-radius: var(--sv-radius-normal);
    background: color-mix(
      in srgb,
      var(--b3-theme-surface, var(--b3-theme-background)) 48%,
      var(--b3-theme-background)
    );
    font-size: var(--sv-text-small);
  }

  .vault-migration-intro p {
    max-width: 680px;
    margin: 6px 0 0;
    line-height: var(--sv-leading-relaxed);
    opacity: .58;
  }

  .vault-migration-result details {
    margin-top: 8px;
  }

  .vault-migration-result ul {
    margin: 8px 0 0;
    padding-left: 20px;
  }

  .vault-migration-result li {
    margin: 4px 0;
    line-height: 1.5;
  }

  .vault-migration-future {
    margin-top: 30px;
    padding-top: 14px;
    border-top: 1px solid var(--b3-border-color);
    font-size: var(--sv-text-small);
    opacity: .42;
  }

  @media (max-width: 760px) {
    .vault-migration-header,
    .vault-migration-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .vault-migration-summary {
      grid-template-columns: 1fr;
    }
  }
</style>
