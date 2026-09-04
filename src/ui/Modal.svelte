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
