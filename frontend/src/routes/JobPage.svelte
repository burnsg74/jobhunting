<script>
  import EventForm from "../components/EventForm.svelte";
  import JobCard from "../components/JobCard.svelte";
  import Timeline from "../components/Timeline.svelte";
  import { api } from "../lib/api.js";
  import { reportError, toasts } from "../lib/app.svelte.js";
  import { jobsCache } from "../lib/jobsCache.svelte.js";
  import { STATUSES, STATUS_LABELS } from "../lib/jobView.js";

  let { id } = $props();

  let detail = $state(null);
  let error = $state("");
  let adding = $state(false);

  async function load() {
    try {
      detail = await api.job(id);
      error = "";
    } catch (e) {
      detail = null;
      error = e.message;
    }
  }

  $effect(() => {
    void id;
    detail = null;
    adding = false;
    load();
  });

  async function changeStatus(status) {
    if (!detail || status === detail.job.status) return;
    try {
      await api.setStatus(id, status);
      if (status === "applied" && detail.job.url) toasts.push("Marked applied. Add the application Q&A as an event if you want to keep it.");
      await Promise.all([load(), jobsCache.load(true)]);
    } catch (e) {
      reportError(e);
    }
  }
</script>

{#if error}
  <h1>Job not found</h1>
  <p class="muted">{error}</p>
  <p><a href="/jobs">Back to Jobs</a></p>
{:else if !detail}
  <p class="muted">Loading…</p>
{:else}
  <div class="page-head">
    <p><a href="/jobs?tab={detail.job.status === 'new' ? 'all' : detail.job.status}">← Jobs</a></p>
    <div class="row">
      <label class="status">
        Status
        <select value={detail.job.status} onchange={(e) => changeStatus(e.currentTarget.value)}>
          {#each STATUSES as s (s)}<option value={s}>{STATUS_LABELS[s]}</option>{/each}
        </select>
      </label>
      <button class="primary" onclick={() => (adding = !adding)}>Add event</button>
    </div>
  </div>

  <div class="layout">
    <JobCard job={detail.job} posting={detail.posting} showStatus />

    <aside>
      <h2>Timeline</h2>
      {#if adding}
        <EventForm
          jobId={id}
          lockJob
          onsaved={() => ((adding = false), load(), jobsCache.load(true))}
          oncancel={() => (adding = false)}
        />
      {/if}
      <Timeline events={detail.events} showJob={false} onchanged={() => (load(), jobsCache.load(true))} />
    </aside>
  </div>
{/if}

<style>
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr);
    gap: 18px;
    align-items: start;
  }

  aside {
    display: grid;
    gap: 10px;
  }

  .status {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--muted);
  }

  p {
    margin: 0;
  }
</style>
