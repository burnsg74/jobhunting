<script>
  import { api } from "../lib/api.js";
  import { reportError } from "../lib/app.svelte.js";
  import { jobPath } from "../lib/router.svelte.js";
  import { EVENT_TYPE_LABELS, NOTE_TYPES, formatTime, localDay } from "../lib/jobView.js";
  import EventForm from "./EventForm.svelte";
  import MarkdownView from "./MarkdownView.svelte";

  // One log entry. `event.body` is already loaded (the API returns bodies for the page being shown).
  let { event, showJob = true, showDate = false, onchanged = () => {} } = $props();

  let editing = $state(false);
  let expanded = $state(false);

  const long = $derived(event.body.length > 500 || event.body.split("\n").length > 10);
  const editable = $derived(NOTE_TYPES.includes(event.type));
  const deletable = $derived(event.type !== "captured" && event.type !== "pull");
  const tone = $derived(
    { applied: "accent", saved: "accent", interviewing: "good", offer: "good", rejected: "bad", deleted: "bad", withdrew: "warn", pull: "", captured: "", note: "", restored: "" }[event.type] ?? "",
  );

  async function remove() {
    if (event.has_body && !window.confirm("Delete this entry and its message?")) return;
    try {
      await api.deleteEvent(event.id);
      onchanged();
    } catch (error) {
      reportError(error);
    }
  }
</script>

{#if editing}
  <EventForm {event} lockJob={false} onsaved={() => ((editing = false), onchanged())} oncancel={() => (editing = false)} />
{:else}
  <article class="entry">
    <div class="head row">
      <span class="time muted">{showDate ? `${localDay(event.at)} ` : ""}{formatTime(event.at)}</span>
      <span class="badge {tone}">{EVENT_TYPE_LABELS[event.type] ?? event.type}</span>
      {#if showJob && event.job_id}
        <a href={jobPath(event.job_id)}>{event.job_name || event.job_id}</a>
        {#if event.job_company}<span class="muted">· {event.job_company}</span>{/if}
      {/if}
      {#if event.summary}<span class="summary">{event.summary}</span>{/if}
      <span class="spacer"></span>
      {#if editable}<button class="link" onclick={() => (editing = true)}>Edit</button>{/if}
      {#if deletable}<button class="link danger" onclick={remove}>Delete</button>{/if}
    </div>
    {#if event.has_body}
      <div class={{ body: true, collapsed: long && !expanded }}>
        <MarkdownView value={event.body} />
      </div>
      {#if long}
        <button class="link more" onclick={() => (expanded = !expanded)}>{expanded ? "Show less" : "Show more"}</button>
      {/if}
    {/if}
  </article>
{/if}

<style>
  .entry {
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }

  .entry:last-child {
    border-bottom: 0;
  }

  .time {
    min-width: 64px;
    font-variant-numeric: tabular-nums;
  }

  .summary {
    color: var(--muted);
  }

  .spacer {
    flex: 1;
  }

  .body {
    margin: 6px 0 0 74px;
  }

  .body.collapsed {
    max-height: 9.5em;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(#000 70%, transparent);
    mask-image: linear-gradient(#000 70%, transparent);
  }

  .more {
    margin: 2px 0 0 74px;
    font-size: 12px;
  }
</style>
