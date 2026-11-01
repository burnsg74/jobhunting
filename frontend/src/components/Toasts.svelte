<script>
  import { toasts } from "../lib/app.svelte.js";
</script>

<div class="toasts" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div class="toast" role="status">
      <span>{t.message}</span>
      {#if t.undo}
        <button
          class="link"
          onclick={() => {
            toasts.dismiss(t.id);
            t.undo();
          }}>Undo <kbd>Z</kbd></button
        >
      {/if}
      <button class="link close" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 50;
    align-items: center;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 14px;
    background: #1c2430;
    color: #fff;
    padding: 9px 14px;
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }

  .toast :global(button.link) {
    color: #9dbcff;
  }

  .toast :global(kbd) {
    background: transparent;
    border-color: #4a5568;
    color: #cbd5e1;
  }

  .close {
    font-size: 18px;
    line-height: 1;
  }
</style>
