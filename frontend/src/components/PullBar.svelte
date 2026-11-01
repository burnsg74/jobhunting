<script>
  import { pull } from "../lib/app.svelte.js";
  import { formatRelative } from "../lib/jobView.js";

  // "Last pulled" text goes stale while the page is open, so tick once a minute.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });

  const run = $derived(pull.run);
  const progress = $derived(
    run
      ? `${run.total ? `Job ${Math.min(run.index, run.total)} of ${run.total}` : "Starting"}: ${run.new} new, ${run.known} known, ${run.failed} failed`
      : "",
  );
</script>

<div class="pull">
  <div class="row">
    {#if pull.running}
      <button onclick={() => pull.cancel()} disabled={run.cancelRequested}>
        {run.cancelRequested ? "Cancelling…" : "Cancel"}
      </button>
      <span class="progress" aria-live="polite">{progress}</span>
    {:else}
      <button class="primary" onclick={() => pull.start()}>Pull from Wellfound</button>
      <span class="muted">
        {pull.lastPulledAt ? `Last pulled ${formatRelative(pull.lastPulledAt, now)}` : "Never pulled"}
      </span>
    {/if}
  </div>
  {#if pull.running && run.log.length}
    <ul class="log">
      {#each run.log.slice(-4) as line, i (i + line)}
        <li>{line}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .pull {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
  }

  .progress {
    font-variant-numeric: tabular-nums;
  }

  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 12px;
    color: var(--muted);
    max-width: 420px;
    text-align: right;
  }

  .log li {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
