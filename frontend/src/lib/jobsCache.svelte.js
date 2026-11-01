// All jobs (no postings), loaded once and shared by the job picker and filters.
import { api } from "./api.js";

class JobsCache {
  list = $state([]);
  loaded = $state(false);
  #pending = null;

  async load(force = false) {
    if (this.loaded && !force) return;
    this.#pending ??= api
      .jobs()
      .then(({ jobs }) => {
        this.list = jobs;
        this.loaded = true;
      })
      .finally(() => (this.#pending = null));
    await this.#pending;
  }
}

export const jobsCache = new JobsCache();
