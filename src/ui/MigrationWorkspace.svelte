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
