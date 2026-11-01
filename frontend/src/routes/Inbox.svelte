<script>
  import { onMount } from "svelte";
  import JobCard from "../components/JobCard.svelte";
  import PullBar from "../components/PullBar.svelte";
  import { api } from "../lib/api.js";
  import { pull, reportError, toasts } from "../lib/app.svelte.js";
  import { indexAfterRemoval, sortInbox } from "../lib/jobFilters.js";
  import { formatFitLabel, formatOverallMatch, localDay } from "../lib/jobView.js";

  let jobs = $state([]); // every job with status new
  let loaded = $state(false);
  let selectedId = $state("");
  let counts = $state({ new_jobs: 0, saved: 0, applied: 0, deleted: 0 });
  let postings = $state({}); // source_id -> markdown, filled on demand
  let postingLoading = $state(false);
  let undoStack = $state.raw([]); // { job, status, promise } newest last
  let queueEl = $state();

  const queue = $derived(sortInbox(jobs));
  const pos = $derived(Math.max(0, queue.findIndex((j) => j.source_id === selectedId)));
  const current = $derived(queue[pos] ?? null);

  // Keep the selection on a real queue item.
  $effect(() => {
    if (current && current.source_id !== selectedId) selectedId = current.source_id;
  });

  // Load the posting for whatever is focused.
  $effect(() => {
    const id = current?.source_id;
    if (!id || id in postings) return;
    postingLoading = true;
    api
      .job(id)
      .then((detail) => (postings[id] = detail.posting))
      .catch(reportError)
      .finally(() => (postingLoading = false));
  });

  // Bring the focused row into view.
  $effect(() => {
    if (!current || !queueEl) return;
    queueEl.querySelector(`[data-id="${CSS.escape(current.source_id)}"]`)?.scrollIntoView({ block: "nearest" });
  });

  async function load() {
    try {
      const { jobs: list } = await api.jobs({ status: "new" });
      jobs = list;
      loaded = true;
    } catch (error) {
      reportError(error);
    }
  }

  async function loadCounts() {
    try {
      const today = localDay(new Date().toISOString());
      const { totals } = await api.daily({ from: today, to: today });
      counts = totals;
    } catch {
      // Header detail only.
    }
  }

  onMount(() => {
    load();
    loadCounts();
    pull.refreshLast();
  });

  // A finished pull adds new jobs.
  let seenPulls = pull.finishedCount;
  $effect(() => {
    if (pull.finishedCount !== seenPulls) {
      seenPulls = pull.finishedCount;
      load();
      loadCounts();
    }
  });

  function move(delta) {
    if (!queue.length) return;
    selectedId = queue[Math.min(queue.length - 1, Math.max(0, pos + delta))].source_id;
  }

  // Acts immediately and advances. The row leaves the queue at once; the write follows.
  function act(status) {
    const job = current;
    if (!job) return;
    if (status === "applied" && job.url) window.open(job.url, "_blank", "noopener,noreferrer");

    const index = pos;
    const nextAfter = indexAfterRemoval(index, queue.length - 1);
    const nextId = queue.filter((j) => j.source_id !== job.source_id)[nextAfter]?.source_id ?? "";
    jobs = jobs.filter((j) => j.source_id !== job.source_id);
    selectedId = nextId;

    const promise = api.setStatus(job.source_id, status);
    const action = { job, status, promise };
    undoStack = [...undoStack, action];
    promise.then(loadCounts).catch((error) => {
      // The write failed: put the job back where it was.
      undoStack = undoStack.filter((a) => a !== action);
      jobs = [...jobs, job];
      selectedId = job.source_id;
      reportError(error);
    });

    const verb = { saved: "Saved", applied: "Applied to", deleted: "Deleted" }[status];
    toasts.push(`${verb} ${job.name} at ${job.company}`, { undo: () => undo(action) });
  }

  async function undo(action = undoStack.at(-1)) {
    if (!action || !undoStack.includes(action)) return;
    undoStack = undoStack.filter((a) => a !== action);
    try {
      const { event } = await action.promise;
      await api.deleteEvent(event.id);
      jobs = [...jobs, action.job];
      selectedId = action.job.source_id;
      loadCounts();
    } catch (error) {
      reportError(error);
    }
  }

  function onkeydown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const el = event.target;
    if (el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
    const key = event.key.toLowerCase();
    const handlers = {
      s: () => act("saved"),
      a: () => act("applied"),
      d: () => act("deleted"),
      z: () => undo(),
      j: () => move(1),
      k: () => move(-1),
      arrowdown: () => move(1),
      arrowright: () => move(1),
      arrowup: () => move(-1),
      arrowleft: () => move(-1),
    };
    const handler = handlers[key];
    if (!handler) return;
    event.preventDefault();
    handler();
  }
</script>

<svelte:window {onkeydown} />

<div class="page-head">
  <div>
    <h1>Inbox</h1>
    <p class="muted stats">
      {#if current}<strong>{pos + 1} of {queue.length}</strong> ·{/if}
      Today: {counts.new_jobs} new, {counts.saved} saved, {counts.applied} applied, {counts.deleted + counts.auto_deleted} deleted
    </p>
  </div>
  <PullBar />
</div>

{#if !loaded}
  <p class="muted">Loading…</p>
{:else if !current}
  <div class="empty panel">
    <h2>Inbox zero.</h2>
    <p class="muted">Pull from Wellfound to bring in new jobs.</p>
  </div>
{:else}
  <div class="layout">
    <ol class="queue panel" bind:this={queueEl} aria-label="Queue">
      {#each queue as job (job.source_id)}
        <li>
          <button class={{ item: true, active: job.source_id === current.source_id }} data-id={job.source_id} onclick={() => (selectedId = job.source_id)}>
            <span class="title">{job.name}</span>
            <span class="muted company">{job.company}</span>
            <span class="meta">
              {#if formatFitLabel(job.fit_recommendation, job.fit_score)}
                <span class="badge">{formatFitLabel(job.fit_recommendation, job.fit_score)}</span>
              {:else}
                <span class="badge warn">Unscored</span>
              {/if}
              {#if job.fit_overall_match}<span class="muted">{formatOverallMatch(job.fit_overall_match)}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ol>

    <div class="focus">
      <div class="actions panel">
        <button class="big good" onclick={() => act("saved")}>Save <kbd>S</kbd></button>
        <button class="big primary" onclick={() => act("applied")}>Apply <kbd>A</kbd></button>
        <button class="big danger" onclick={() => act("deleted")}>Delete <kbd>D</kbd></button>
        <span class="spacer"></span>
        <button onclick={() => move(-1)} disabled={pos === 0} title="Previous (K)">← Prev</button>
        <button onclick={() => move(1)} disabled={pos >= queue.length - 1} title="Next (J)">Next →</button>
        <button onclick={() => undo()} disabled={undoStack.length === 0} title="Undo (Z)">Undo <kbd>Z</kbd></button>
      </div>
      {#key current.source_id}
        <JobCard job={current} posting={postings[current.source_id] ?? ""} loading={postingLoading && !(current.source_id in postings)} />
      {/key}
    </div>
  </div>
{/if}

<style>
  .stats {
    margin: 2px 0 0;
  }

  .layout {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  @media (max-width: 960px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .queue {
      position: static;
      max-height: 220px;
    }
  }

  .queue {
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: calc(100vh - 210px);
    overflow-y: auto;
    position: sticky;
    top: 62px;
  }

  .item {
    display: grid;
    gap: 2px;
    width: 100%;
    text-align: left;
    border: 0;
    border-radius: 6px;
    padding: 8px 10px;
  }

  .item.active {
    background: var(--accent-soft);
  }

  .title {
    font-weight: 600;
  }

  .company {
    font-size: 13px;
  }

  .meta {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
  }

  .focus {
    display: grid;
    gap: 12px;
    min-width: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    position: sticky;
    top: 56px;
    z-index: 5;
  }

  .spacer {
    flex: 1;
  }

  .empty {
    text-align: center;
    padding: 56px 16px;
  }

  .empty h2 {
    font-size: 22px;
  }
</style>
