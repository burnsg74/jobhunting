<script>
  import { onMount } from "svelte";
  import Toasts from "./components/Toasts.svelte";
  import { banner, pull } from "./lib/app.svelte.js";
  import { matchRoute, router } from "./lib/router.svelte.js";
  import Inbox from "./routes/Inbox.svelte";
  import JobPage from "./routes/JobPage.svelte";
  import Jobs from "./routes/Jobs.svelte";
  import Log from "./routes/Log.svelte";
  import Reports from "./routes/Reports.svelte";

  const route = $derived(matchRoute(router.path));

  const links = [
    { href: "/", label: "Inbox", match: (n) => n === "inbox" },
    { href: "/jobs", label: "Jobs", match: (n) => n === "jobs" || n === "job" },
    { href: "/log", label: "Log", match: (n) => n === "log" },
    { href: "/reports", label: "Reports", match: (n) => n === "reports" },
  ];

  onMount(() => pull.init());
</script>

<svelte:window onclick={router.handleClick} />

<header>
  <a class="brand" href="/">Job Hunting</a>
  <nav>
    {#each links as link (link.href)}
      <a href={link.href} class={{ active: link.match(route.name) }}>{link.label}</a>
    {/each}
  </nav>
</header>

{#if banner.error}
  <div class="banner" role="alert">
    <span>{banner.error}</span>
    <button onclick={() => (banner.error = "")}>Dismiss</button>
  </div>
{/if}

<main>
  {#if route.name === "inbox"}
    <Inbox />
  {:else if route.name === "jobs"}
    <Jobs />
  {:else if route.name === "job"}
    <JobPage id={route.jobId} />
  {:else if route.name === "log"}
    <Log />
  {:else if route.name === "reports"}
    <Reports />
  {:else}
    <h1>Not found</h1>
    <p><a href="/">Back to the Inbox</a></p>
  {/if}
</main>

<Toasts />

<style>
  header {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 10px 24px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .brand {
    font-weight: 700;
    font-size: 16px;
    color: var(--text);
  }

  nav {
    display: flex;
    gap: 4px;
  }

  nav a {
    padding: 5px 12px;
    border-radius: 6px;
    color: var(--muted);
  }

  nav a:hover {
    text-decoration: none;
    background: var(--bg);
  }

  nav a.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  main {
    padding: 18px 24px 80px;
    max-width: 1500px;
    margin: 0 auto;
  }

  .banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    background: var(--bad-soft);
    color: var(--bad);
    padding: 8px 24px;
    border-bottom: 1px solid var(--line);
  }
</style>
