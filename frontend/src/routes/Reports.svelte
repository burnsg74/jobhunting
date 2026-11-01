<script>
  import BarChart from "../components/BarChart.svelte";
  import { api } from "../lib/api.js";
  import { reportError } from "../lib/app.svelte.js";
  import { localDay } from "../lib/jobView.js";
  import { router } from "../lib/router.svelte.js";

  const COLUMNS = [
    { key: "new_jobs", label: "New jobs" },
    { key: "auto_deleted", label: "Auto-deleted" },
    { key: "to_triage", label: "To triage" },
    { key: "saved", label: "Saved" },
    { key: "applied", label: "Applied" },
    { key: "deleted", label: "Deleted (by me)" },
    { key: "interviewing", label: "Interviewing" },
    { key: "rejected", label: "Rejected" },
  ];

  const isoDay = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return localDay(d.toISOString());
  };

  let from = $state(isoDay(-13));
  let to = $state(isoDay(0));
  let report = $state(null);
  let requestId = 0;

  $effect(() => {
    const mine = ++requestId;
    if (!from || !to || from > to) return;
    api
      .daily({ from, to })
      .then((r) => {
        if (mine === requestId) report = r;
      })
      .catch(reportError);
  });

  const short = (date) => date.slice(5).replace("-", "/");
  const labels = $derived(report ? report.days.map((d) => short(d.date)) : []);
  const series = $derived(
    report
      ? [
          { name: "New jobs", color: "#2557d6", values: report.days.map((d) => d.new_jobs) },
          { name: "Applied", color: "#137a3d", values: report.days.map((d) => d.applied) },
        ]
      : [],
  );

  const openDay = (date) => router.navigate(`/log?from=${date}&to=${date}`);
</script>

<div class="page-head">
  <h1>Reports</h1>
  <div class="row range">
    <label>From <input type="date" bind:value={from} /></label>
    <label>To <input type="date" bind:value={to} /></label>
  </div>
</div>

{#if from > to}
  <p class="neg">The start date is after the end date.</p>
{:else if !report}
  <p class="muted">Loading…</p>
{:else}
  <section class="panel chart">
    <h2>New jobs vs Applied per day</h2>
    <BarChart {labels} {series} onselect={(i) => openDay(report.days[i].date)} />
  </section>

  <section class="panel">
    <table class="simple">
      <thead>
        <tr>
          <th>Day</th>
          {#each COLUMNS as c (c.key)}<th class="num">{c.label}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each [...report.days].reverse() as day (day.date)}
          <tr class={{ zero: COLUMNS.every((c) => day[c.key] === 0) }}>
            <td><a href="/log?from={day.date}&to={day.date}">{day.date}</a></td>
            {#each COLUMNS as c (c.key)}<td class="num">{day[c.key]}</td>{/each}
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr>
          <th>Total</th>
          {#each COLUMNS as c (c.key)}<th class="num">{report.totals[c.key]}</th>{/each}
        </tr>
      </tfoot>
    </table>
  </section>
{/if}

<style>
  .range label {
    display: flex;
    gap: 6px;
    align-items: center;
    color: var(--muted);
  }

  .chart {
    margin-bottom: 14px;
  }

  tr.zero td {
    color: var(--muted);
  }

  tfoot th {
    border-top: 2px solid var(--line);
    border-bottom: 0;
    color: var(--text);
  }
</style>
