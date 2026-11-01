<script>
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { reportError, toasts } from "../lib/app.svelte.js";
  import { jobsCache } from "../lib/jobsCache.svelte.js";
  import { formatFitLabel, formatOverallMatch, formatRelative } from "../lib/jobView.js";
  import { jobPath, router } from "../lib/router.svelte.js";

  const TABS = [
    { id: "saved", label: "Saved" },
    { id: "applied", label: "Applied" },
    { id: "interviewing", label: "Interviewing" },
    { id: "rejected", label: "Rejected" },
    { id: "deleted", label: "Deleted" },
    { id: "all", label: "All" },
  ];

  let jobs = $state([]);
  let loaded = $state(false);
  let q = $state(router.query.get("q") ?? "");
  let autoOnly = $state(false);

  const tab = $derived(TABS.some((t) => t.id === router.query.get("tab")) ? router.query.get("tab") : "saved");

  function setTab(id) {
    router.navigate(`/jobs?tab=${id}`);
  }

  async function load() {
    try {
      jobs = (await api.jobs()).jobs;
      loaded = true;
    } catch (error) {
      reportError(error);
    }
  }
  onMount(load);

  const needle = $derived(q.trim().toLowerCase());
  const searched = $derived(
    needle ? jobs.filter((j) => [j.name, j.company, j.skills, j.locations].some((v) => v.toLowerCase().includes(needle))) : jobs,
  );
  const counts = $derived(Object.fromEntries(TABS.map((t) => [t.id, t.id === "all" ? searched.length : searched.filter((j) => j.status === t.id).length])));
  const rows = $derived(
    searched
      .filter((j) => tab === "all" || j.status === tab)
      .filter((j) => !(tab === "deleted" && autoOnly) || j.auto_deleted)
      .sort((a, b) => (a.status_at < b.status_at ? 1 : a.status_at > b.status_at ? -1 : 0)),
  );

  async function act(job, status) {
    // Open the posting from the click itself so the browser allows the new tab.
    if (status === "applied" && job.url) window.open(job.url, "_blank", "noopener,noreferrer");
    try {
      await api.setStatus(job.source_id, status);
      toasts.push(`${job.name}: ${status === "new" ? "restored to the inbox" : status}`);
      await Promise.all([load(), jobsCache.load(true)]);
    } catch (error) {
      reportError(error);
    }
  }
</script>

<div class="page-head">
  <h1>Jobs</h1>
  <input type="search" placeholder="Search name, company, skills…" bind:value={q} aria-label="Search" />
</div>

<div class="tabs" role="tablist">
  {#each TABS as t (t.id)}
    <button role="tab" aria-selected={tab === t.id} class={{ on: tab === t.id }} onclick={() => setTab(t.id)}>
      {t.label} <span class="muted">{counts[t.id]}</span>
    </button>
  {/each}
  {#if tab === "deleted"}
    <label class="auto"><input type="checkbox" bind:checked={autoOnly} /> Auto-deleted only</label>
  {/if}
</div>

{#if !loaded}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">No jobs here.</p>
{:else}
  <div class="panel">
    <table class="simple">
      <thead>
        <tr><th>Job</th><th>Pay</th><th>Fit</th><th>Since</th><th></th><th></th></tr>
      </thead>
      <tbody>
        {#each rows as job (job.source_id)}
          <tr>
            <td>
              <a href={jobPath(job.source_id)}>{job.name}</a>
              <div class="muted">{job.company}</div>
            </td>
            <td>{job.compensation || "—"}</td>
            <td>
              {formatFitLabel(job.fit_recommendation, job.fit_score) ?? "—"}
              {#if job.fit_overall_match}<span class="muted">· {formatOverallMatch(job.fit_overall_match)}</span>{/if}
            </td>
            <td class="muted" title={job.status_at}>{tab === "all" ? `${job.status} ` : ""}{formatRelative(job.status_at)}</td>
            <td>
              {#if job.auto_deleted}<span class="badge bad">Auto-deleted</span>{/if}
              {#if job.no_reply}<span class="badge warn">No reply, 14d</span>{/if}
            </td>
            <td class="actions">
              {#if job.status === "saved"}
                <button class="primary" onclick={() => act(job, "applied")}>Apply</button>
                <button class="danger" onclick={() => act(job, "deleted")}>Delete</button>
              {:else if job.status === "applied"}
                <button onclick={() => act(job, "interviewing")}>Interviewing</button>
                <button class="danger" onclick={() => act(job, "rejected")}>Rejected</button>
              {:else if job.status === "deleted"}
                <button onclick={() => act(job, "new")}>Restore</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .tabs {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .tabs button[role="tab"] {
    border-color: transparent;
    background: none;
  }

  .tabs button.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .auto {
    margin-left: 12px;
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .actions {
    text-align: right;
    white-space: nowrap;
  }

  .actions button {
    margin-left: 6px;
  }
</style>
