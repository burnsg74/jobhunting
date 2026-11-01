<script>
  import EventForm from "../components/EventForm.svelte";
  import JobPicker from "../components/JobPicker.svelte";
  import Timeline from "../components/Timeline.svelte";
  import { api } from "../lib/api.js";
  import { reportError } from "../lib/app.svelte.js";
  import { jobsCache } from "../lib/jobsCache.svelte.js";
  import { EVENT_TYPE_LABELS } from "../lib/jobView.js";
  import { router } from "../lib/router.svelte.js";

  const PAGE = 100;
  const TYPES = Object.keys(EVENT_TYPE_LABELS);

  // Filters start from the URL (Reports links here with ?from=&to=).
  const initial = router.query;
  let type = $state(initial.get("type") ?? "");
  let job = $state(initial.get("job") ?? "");
  let from = $state(initial.get("from") ?? "");
  let to = $state(initial.get("to") ?? "");

  let events = $state([]);
  let total = $state(0);
  let loaded = $state(false);
  let adding = $state(false);
  let requestId = 0;

  async function load({ more = false } = {}) {
    const mine = ++requestId;
    try {
      const res = await api.events({
        type,
        job_id: job,
        from,
        to,
        limit: PAGE,
        offset: more ? events.length : 0,
        bodies: 1,
      });
      if (mine !== requestId) return; // a newer filter change superseded this request
      events = more ? [...events, ...res.events] : res.events;
      total = res.total;
      loaded = true;
    } catch (error) {
      reportError(error);
    }
  }

  // Reload whenever a filter changes.
  $effect(() => {
    void [type, job, from, to];
    load();
  });

  function changed() {
    load();
    jobsCache.load(true);
  }

  function clear() {
    type = job = from = to = "";
  }
</script>

<div class="page-head">
  <h1>Log</h1>
  <button class="primary" onclick={() => (adding = !adding)}>Add event</button>
</div>

{#if adding}
  <div class="add">
    <EventForm onsaved={() => ((adding = false), changed())} oncancel={() => (adding = false)} />
  </div>
{/if}

<div class="filters row panel">
  <label>
    Type
    <select bind:value={type}>
      <option value="">All types</option>
      {#each TYPES as t (t)}<option value={t}>{EVENT_TYPE_LABELS[t]}</option>{/each}
    </select>
  </label>
  <label class="jobfilter">
    Job
    <JobPicker bind:value={job} placeholder="Any job" />
  </label>
  <label>From <input type="date" bind:value={from} /></label>
  <label>To <input type="date" bind:value={to} /></label>
  {#if type || job || from || to}<button class="link" onclick={clear}>Clear filters</button>{/if}
</div>

{#if !loaded}
  <p class="muted">Loading…</p>
{:else}
  <Timeline {events} onchanged={changed} />
  {#if events.length < total}
    <p><button onclick={() => load({ more: true })}>Load more ({total - events.length} older)</button></p>
  {/if}
{/if}

<style>
  .add {
    margin-bottom: 14px;
  }

  .filters {
    gap: 16px;
    margin-bottom: 16px;
    align-items: flex-end;
  }

  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  label :global(input),
  label :global(select) {
    font-size: 14px;
    color: var(--text);
  }
</style>
