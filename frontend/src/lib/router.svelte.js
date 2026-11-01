// Tiny history-API router. nginx serves index.html for every path (SPA fallback).

class Router {
  path = $state(window.location.pathname);
  search = $state(window.location.search);

  constructor() {
    window.addEventListener("popstate", () => {
      this.path = window.location.pathname;
      this.search = window.location.search;
    });
  }

  /** Query string as URLSearchParams (reactive: reads `search`). */
  get query() {
    return new URLSearchParams(this.search);
  }

  navigate(to, { replace = false } = {}) {
    const url = new URL(to, window.location.origin);
    if (url.pathname === this.path && url.search === this.search) return;
    const target = url.pathname + url.search;
    if (replace) window.history.replaceState({}, "", target);
    else window.history.pushState({}, "", target);
    this.path = url.pathname;
    this.search = url.search;
    window.scrollTo(0, 0);
  }

  /** Intercept same-origin <a href="/..."> clicks. */
  handleClick = (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    event.preventDefault();
    this.navigate(href);
  };
}

export const router = new Router();

export const jobPath = (id) => `/jobs/${encodeURIComponent(id)}`;

/** Match the current path against the route table. */
export function matchRoute(path) {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return { name: "inbox" };
  if (clean === "/jobs") return { name: "jobs" };
  if (clean === "/log") return { name: "log" };
  if (clean === "/reports") return { name: "reports" };
  const detail = /^\/jobs\/([^/]+)$/.exec(clean);
  if (detail) {
    try {
      return { name: "job", jobId: decodeURIComponent(detail[1]) };
    } catch {
      return { name: "notfound" };
    }
  }
  return { name: "notfound" };
}
