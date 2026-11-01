<script>
  import EventEntry from "./EventEntry.svelte";
  import { dayHeading, localDay } from "../lib/jobView.js";

  // Events grouped by local day, newest first. Shared by the Log and each job's timeline.
  let { events, showJob = true, onchanged = () => {} } = $props();

  const groups = $derived.by(() => {
    const map = new Map();
    for (const e of events) {
      const day = localDay(e.at);
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(e);
    }
    return [...map];
  });
</script>

{#if events.length === 0}
  <p class="muted">Nothing logged yet.</p>
{:else}
  {#each groups as [day, list] (day)}
    <section class="day">
      <h2>{dayHeading(day)} <span class="muted count">{list.length}</span></h2>
      {#each list as event (event.id)}
        <EventEntry {event} {showJob} {onchanged} />
      {/each}
    </section>
  {/each}
{/if}

<style>
  .day {
    margin-bottom: 18px;
  }

  h2 {
    position: sticky;
    top: 50px;
    background: var(--bg);
    padding: 4px 0;
    z-index: 2;
    border-bottom: 1px solid var(--line);
    margin-bottom: 2px;
  }

  .count {
    font-weight: 400;
    font-size: 12px;
    margin-left: 6px;
  }
</style>
