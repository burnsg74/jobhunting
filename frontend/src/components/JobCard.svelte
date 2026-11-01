<script>
  import { csvOrDash, formatDate, formatFitLabel, formatOverallMatch, formatPostedAt, splitList, toSecondPerson, STATUS_LABELS } from "../lib/jobView.js";
  import MarkdownView from "./MarkdownView.svelte";

  // The same card is used by the Inbox focus pane and the job page.
  let { job, posting = "", loading = false, showStatus = false, children } = $props();

  const fitLabel = $derived(formatFitLabel(job.fit_recommendation, job.fit_score));
  const fitTone = $derived(
    job.fit_recommendation === "STRONG_PASS" || job.fit_recommendation === "PASS"
      ? "good"
      : job.fit_recommendation === "SKIP"
        ? "bad"
        : job.fit_recommendation === "HOLD"
          ? "warn"
          : "",
  );
  const skills = $derived(splitList(job.skills));
  const summary = $derived(toSecondPerson(job.fit_summary));
</script>

<article class="card panel">
  <header>
    <h1>{job.name}</h1>
    <div class="row sub">
      {#if job.company_url}
        <a href={job.company_url} target="_blank" rel="noopener noreferrer">{job.company}</a>
      {:else}
        <span>{job.company}</span>
      {/if}
      {#if showStatus}
        <span class="badge accent">{STATUS_LABELS[job.status] ?? job.status}</span>
      {/if}
      {#if job.auto_deleted}<span class="badge bad">Auto-deleted</span>{/if}
      {#if job.no_reply}<span class="badge warn">No reply, 14d</span>{/if}
    </div>
  </header>

  <dl class="facts">
    <div><dt>Pay</dt><dd>{job.compensation || "—"}</dd></div>
    {#if job.equity}<div><dt>Equity</dt><dd>{job.equity}</dd></div>{/if}
    <div>
      <dt>Remote</dt>
      <dd>{job.remote === "true" ? "Fully remote" : job.remote === "false" ? "Not fully remote" : "—"}</dd>
    </div>
    <div><dt>Where</dt><dd>{job.locations || "—"}</dd></div>
    {#if job.experience_min}<div><dt>Experience</dt><dd>{job.experience_min}+ years</dd></div>{/if}
    {#if job.job_type}<div><dt>Type</dt><dd>{job.job_type.replaceAll("_", " ")}</dd></div>{/if}
    {#if job.posted_at}<div><dt>Posted</dt><dd>{formatPostedAt(job.posted_at)}</dd></div>{/if}
    <div><dt>Captured</dt><dd>{formatDate(job.captured_at)}</dd></div>
  </dl>

  {#if skills.length}
    <div class="chips">
      {#each skills as skill (skill)}<span class="badge">{skill}</span>{/each}
    </div>
  {/if}

  {#if fitLabel || job.fit_error}
    <section class="fit">
      <div class="row">
        {#if fitLabel}<span class="badge {fitTone}">{fitLabel}</span>{/if}
        {#if job.fit_overall_match}<span class="muted">{formatOverallMatch(job.fit_overall_match)} match</span>{/if}
        {#if job.fit_error}<span class="badge warn">Unscored: {job.fit_error}</span>{/if}
      </div>
      {#if summary}<p>{summary}</p>{/if}
      {#if job.fit_have_skills || job.fit_familiar_skills || job.fit_dont_have_skills}
        <dl class="skills">
          <div><dt>Have</dt><dd>{csvOrDash(job.fit_have_skills)}</dd></div>
          <div><dt>Familiar</dt><dd>{csvOrDash(job.fit_familiar_skills)}</dd></div>
          <div><dt>Don't have</dt><dd>{csvOrDash(job.fit_dont_have_skills)}</dd></div>
        </dl>
      {/if}
    </section>
  {/if}

  {#if children}{@render children()}{/if}

  <div class="links">
    {#if job.url}<a href={job.url} target="_blank" rel="noopener noreferrer">Open on Wellfound ↗</a>{/if}
  </div>

  <section class="posting">
    <h2>Posting</h2>
    {#if loading}
      <p class="muted">Loading…</p>
    {:else if posting}
      <MarkdownView value={posting} />
    {:else}
      <p class="muted">No posting text saved.</p>
    {/if}
  </section>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .sub {
    margin-top: 4px;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 8px 18px;
    margin: 0;
  }

  dt {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  dd {
    margin: 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .fit {
    background: var(--bg);
    border-radius: var(--radius);
    padding: 10px 12px;
  }

  .fit p {
    margin: 8px 0;
  }

  .skills {
    display: grid;
    gap: 6px;
    margin: 0;
    font-size: 13px;
  }

  .posting {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
</style>
