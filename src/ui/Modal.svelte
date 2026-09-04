<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    muted = "",
    busy = false,
    onBackdrop,
    children,
  } = $props<{
    title: string;
    muted?: string;
    busy?: boolean;
    onBackdrop: () => void;
    children: Snippet;
  }>();
</script>

<div
  class="vault-modal-backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget && !busy) onBackdrop();
  }}
>
  <section class="vault-modal" role="dialog" aria-modal="true">
    <h3>{title}</h3>
    {#if muted}
      <p class="vault-muted">{muted}</p>
    {/if}
    {@render children()}
  </section>
</div>

<style>
  .vault-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, .32);
  }

  .vault-modal {
    width: min(440px, calc(100vw - 36px));
    max-height: min(720px, calc(100vh - 50px));
    overflow: auto;
    padding: 18px;
    border: var(--sv-border);
    border-radius: var(--sv-radius-large);
    background: var(--b3-theme-background);
    box-shadow: var(--b3-dialog-shadow);
    font-family: var(--b3-font-family);
    font-size: var(--sv-text-normal);
  }

  .vault-modal h3 {
    margin: 0 0 6px;
    font-size: var(--sv-text-normal);
    font-weight: var(--sv-weight-strong);
  }

  .vault-muted {
    font-size: var(--sv-text-small);
    line-height: var(--sv-leading-relaxed);
    opacity: .62;
  }
</style>
