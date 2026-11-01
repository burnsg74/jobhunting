// App-wide UI state: toasts, the error banner, and the Wellfound pull.
import { api } from "./api.js";

export const banner = $state({ error: "" });

export function reportError(error) {
  banner.error = error instanceof Error ? error.message : String(error);
}

class Toasts {
  items = $state([]);
  #next = 1;

  /** Show a toast. `undo` adds an Undo button; it stays up about 8 seconds. */
  push(message, { undo = null, ms = 8000 } = {}) {
    const id = this.#next++;
    this.items.push({ id, message, undo });
    setTimeout(() => this.dismiss(id), ms);
    return id;
  }

  dismiss(id) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new Toasts();

class Pull {
  run = $state(null);
  lastPulledAt = $state("");
  /** Bumps whenever a pull finishes so pages can reload. */
  finishedCount = $state(0);
  #timer = null;
  #sawRunning = false;

  get running() {
    return this.run?.status === "running";
  }

  async init() {
    await Promise.all([this.refreshLast(), this.poll()]);
  }

  async refreshLast() {
    try {
      const { events } = await api.events({ type: "pull", limit: 1 });
      this.lastPulledAt = events[0]?.at ?? "";
    } catch {
      // Header detail only; the page's own load reports real errors.
    }
  }

  async poll() {
    try {
      const { run } = await api.currentPull();
      this.#apply(run);
    } catch (error) {
      reportError(error);
      this.#stop();
    }
  }

  #apply(run) {
    const wasRunning = this.#sawRunning;
    this.run = run;
    if (run?.status === "running") {
      this.#sawRunning = true;
      if (!this.#timer) this.#timer = setInterval(() => this.poll(), 2000);
      return;
    }
    this.#stop();
    if (wasRunning && run) {
      this.#sawRunning = false;
      this.#finished(run);
    }
  }

  #stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #finished(run) {
    await this.refreshLast();
    this.finishedCount++;
    const label = run.status === "failed" ? `Pull failed${run.error ? `: ${run.error}` : ""}` : run.status === "cancelled" ? "Pull cancelled" : "Pull finished";
    toasts.push(`${label}. ${run.new} new job${run.new === 1 ? "" : "s"}, ${run.known} known, ${run.failed} failed.`, { ms: 10000 });
  }

  async start() {
    try {
      const { run } = await api.startPull();
      this.#sawRunning = true;
      this.#apply(run);
    } catch (error) {
      reportError(error);
    }
  }

  async cancel() {
    try {
      const { run } = await api.cancelPull();
      this.#apply(run);
    } catch (error) {
      reportError(error);
    }
  }
}

export const pull = new Pull();
