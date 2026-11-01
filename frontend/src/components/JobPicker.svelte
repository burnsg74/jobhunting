<script>
  import { jobsCache } from "../lib/jobsCache.svelte.js";

  // Searchable job picker. `value` is a source_id ("" = none).
  let { value = $bindable(""), disabled = false, placeholder = "Search jobs…", allowNone = true } = $props();

  let query = $state("");
  let open = $state(false);
  let active = $state(0);

  jobsCache.load();

  const selected = $derived(jobsCache.list.find((j) => j.source_id === value) ?? null);
  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? jobsCache.list.filter((j) => `${j.name} ${j.company}`.toLowerCase().includes(needle))
      : jobsCache.list;
    return list.slice(0, 8);
  });

  function choose(id) {
    value = id;
    query = "";
    open = false;
  }

  function onkeydown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(matches.length - 1, active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
    } else if (event.key === "Enter" && open && matches[active]) {
      event.preventDefault();
      choose(matches[active].source_id);
    } else if (event.key === "Escape") {
      open = false;
    }
  }
</script>

<div class="picker">
  {#if selected && !open}
    <div class="chosen">
      <span>{selected.name} · <span class="muted">{selected.company}</span></span>
      {#if !disabled}
        <button type="button" class="link" onclick={() => (open = true)}>Change</button>
        {#if allowNone}<button type="button" class="link" onclick={() => choose("")}>Clear</button>{/if}
      {/if}
    </div>
  {:else if disabled}
    <span class="muted">{value ? value : "No job"}</span>
  {:else}
    <input
      type="search"
      {placeholder}
      bind:value={query}
      onfocus={() => (open = true)}
      oninput={() => ((open = true), (active = 0))}
      onblur={() => setTimeout(() => (open = false), 120)}
      {onkeydown}
      aria-label="Job"
    />
    {#if open && matches.length}
      <ul role="listbox">
        {#each matches as job, i (job.source_id)}
          <li role="option" aria-selected={i === active}>
            <button type="button" class={{ on: i === active }} onmousedown={(e) => (e.preventDefault(), choose(job.source_id))}>
              {job.name} <span class="muted">· {job.company}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .picker {
    position: relative;
    min-width: 260px;
  }

  input {
    width: 100%;
  }

  .chosen {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  ul {
    list-style: none;
    margin: 2px 0 0;
    padding: 4px;
    position: absolute;
    left: 0;
    right: 0;
    z-index: 20;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  }

  li button {
    width: 100%;
    text-align: left;
    border: 0;
    padding: 5px 8px;
  }

  li button.on {
    background: var(--accent-soft);
  }
</style>
