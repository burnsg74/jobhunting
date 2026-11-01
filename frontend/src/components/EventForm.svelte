<script>
  import { untrack } from "svelte";
  import { api } from "../lib/api.js";
  import { reportError } from "../lib/app.svelte.js";
  import { EVENT_TYPE_LABELS, MANUAL_TYPES, NOTE_TYPES, fromLocalInput, toLocalInput } from "../lib/jobView.js";
  import JobPicker from "./JobPicker.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";

  // Add (or edit) a log event. Status types move the job; offer/withdrew/note only record.
  let { event = null, jobId = "", lockJob = false, defaultType = "note", onsaved = () => {}, oncancel = () => {} } = $props();

  const editing = $derived(Boolean(event));
  // Starting values only; the form owns them after mount.
  let type = $state(untrack(() => event?.type ?? defaultType));
  let job = $state(untrack(() => event?.job_id ?? jobId));
  let when = $state(untrack(() => toLocalInput(event?.at ?? new Date().toISOString())));
  let whenTouched = $state(false);
  let saving = $state(false);
  let editor = $state();

  const types = $derived(editing ? NOTE_TYPES : MANUAL_TYPES);
  const needsJob = $derived(!NOTE_TYPES.includes(type));

  async function save() {
    if (saving) return;
    if (needsJob && !job) return reportError(new Error(`${EVENT_TYPE_LABELS[type]} needs a job`));
    saving = true;
    try {
      const body = editor?.getMarkdown() ?? "";
      const at = editing || whenTouched ? fromLocalInput(when) : undefined;
      const saved = editing
        ? await api.updateEvent(event.id, { type, job_id: job, at, body })
        : await api.createEvent({ type, job_id: job, body, ...(at ? { at } : {}) });
      onsaved(saved);
    } catch (error) {
      reportError(error);
    } finally {
      saving = false;
    }
  }
</script>

<form class="panel form" onsubmit={(e) => (e.preventDefault(), save())}>
  <div class="row fields">
    <label>
      Type
      <select bind:value={type}>
        {#each types as t (t)}<option value={t}>{EVENT_TYPE_LABELS[t]}</option>{/each}
      </select>
    </label>
    <label class="job">
      Job {needsJob ? "" : "(optional)"}
      <JobPicker bind:value={job} disabled={lockJob} allowNone={!needsJob} />
    </label>
    <label>
      When
      <input type="datetime-local" bind:value={when} oninput={() => (whenTouched = true)} />
    </label>
  </div>
  <MarkdownEditor bind:this={editor} value={event?.body ?? ""} onsubmit={save} />
  <div class="row">
    <button type="submit" class="primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add event"} <kbd>⌘↵</kbd></button>
    <button type="button" onclick={oncancel}>Cancel</button>
    {#if needsJob && !editing}
      <span class="muted">{EVENT_TYPE_LABELS[type]} also moves the job's status.</span>
    {/if}
  </div>
</form>

<style>
  .form {
    display: grid;
    gap: 12px;
  }

  .fields {
    align-items: flex-start;
    gap: 16px;
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

  .job {
    flex: 1;
    min-width: 260px;
  }
</style>
