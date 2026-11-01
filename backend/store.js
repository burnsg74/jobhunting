// File-backed store: jobs.csv, events.csv, postings/{source_id}.md, events/{id}.md.
// All mutations go through one serialized writer. Markdown files are written before the CSV rows
// that point at them; deletes update the CSV first, then remove the file. Every write is atomic
// (temp file + rename). Reads always come from disk so edits made in an editor or synced by
// Dropbox show up on the next request.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ALL_EVENT_TYPES,
  EVENTS_DIR,
  EVENTS_FILE,
  JOBS_FILE,
  JOB_COLUMNS,
  MANUAL_EVENT_TYPES,
  NOTE_EVENT_TYPES,
  POSTINGS_DIR,
  STATUSES,
  ValidationError,
  autoSummary,
  compareEvents,
  emptyJob,
  eventTypeForStatus,
  isStatusEventType,
  isValidEventId,
  isValidSourceId,
  isNoReply,
  appliedAt,
  isAutoSummary,
  parseEvents,
  parseJobs,
  statusForEvent,
  stringifyEvents,
  stringifyJobs,
  toIso,
  validateEvent,
  validateJob,
} from "./schema.js";
import { DEFAULT_TZ, localDate, localStamp } from "./tz.js";

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class DataAccessError extends Error {}

export const IO_TIMEOUT_MS = 5000;

// On macOS a launchd-started node (pm2 at login) can block forever reading Dropbox's
// File Provider folder until the node binary is granted Full Disk Access. Without a guard,
// every request would park a libuv thread and the API would stop answering. So: time out
// with an actionable message, and share one in-flight read per file.
function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DataAccessError(
            `Timed out ${what}. If this runs under pm2/launchd on macOS, grant Full Disk Access to ${process.execPath} ` +
              "(System Settings > Privacy & Security > Full Disk Access) and restart jobhunting-api.",
          ),
        ),
      IO_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const inflightReads = new Map();

function readText(file) {
  let pending = inflightReads.get(file);
  if (!pending) {
    pending = readFile(file, "utf8")
      .catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
      .finally(() => inflightReads.delete(file));
    inflightReads.set(file, pending);
  }
  return withTimeout(pending, `reading ${path.basename(file)}`);
}

async function writeAtomic(file, text) {
  await withTimeout(
    (async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
    })(),
    `writing ${path.basename(file)}`,
  );
}

async function removeFile(file) {
  await withTimeout(rm(file, { force: true }), `removing ${path.basename(file)}`);
}

/** Real read (not just access()) so health reflects whether the data can actually be used. */
export async function probeReadable(file) {
  try {
    await readText(file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const nowIso = () => new Date().toISOString();
const plusMs = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

const str = (v) => (v === null || v === undefined ? "" : String(v));

const JOB_INPUT_FIELDS = JOB_COLUMNS.filter((c) => !["status", "status_at", "auto_deleted"].includes(c));

export function newEventId(at, taken, tz) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 50; attempt++) {
    let suffix = "";
    for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const id = `${localStamp(at, tz)}-${suffix}`;
    if (!taken.has(id)) return id;
  }
  throw new ConflictError("Could not allocate an event id");
}

export function createStore(dir, { tz = DEFAULT_TZ } = {}) {
  const jobsPath = path.join(dir, JOBS_FILE);
  const eventsPath = path.join(dir, EVENTS_FILE);
  const postingPath = (id) => path.join(dir, POSTINGS_DIR, `${id}.md`);
  const eventBodyPath = (id) => path.join(dir, EVENTS_DIR, `${id}.md`);
  let queue = Promise.resolve();

  async function load() {
    const [j, e] = await Promise.all([readText(jobsPath), readText(eventsPath)]);
    return { jobs: j ? parseJobs(j) : [], events: e ? parseEvents(e) : [] };
  }

  const readBody = (id) => readText(eventBodyPath(id));

  // Serialize read-modify-write cycles. `fn(state, tx)` mutates state and returns
  // { result, jobs?: bool, events?: bool }. `tx.write(file, text)` / `tx.remove(file)` queue file work.
  function mutate(fn) {
    const run = queue.then(async () => {
      const state = await load();
      const writes = [];
      const removes = [];
      const tx = {
        write: (file, text) => writes.push([file, text]),
        remove: (file) => removes.push(file),
      };
      const outcome = await fn(state, tx);
      if (new Set(state.jobs.map((j) => j.source_id)).size !== state.jobs.length) {
        throw new ConflictError("Duplicate source_id");
      }
      if (new Set(state.events.map((e) => e.id)).size !== state.events.length) {
        throw new ConflictError("Duplicate event id");
      }
      for (const [file, text] of writes) await writeAtomic(file, text);
      if (outcome.jobs) await writeAtomic(jobsPath, stringifyJobs(state.jobs));
      if (outcome.events) await writeAtomic(eventsPath, stringifyEvents(state.events));
      for (const file of removes) await removeFile(file);
      return outcome.result;
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Append an event to `state`; queues its markdown file. Does not touch the job row. */
  function pushEvent(state, tx, { at, job_id = "", type, summary = "", body = "" }) {
    const when = toIso(at ?? nowIso());
    const id = newEventId(when, new Set(state.events.map((e) => e.id)), tz);
    const text = typeof body === "string" ? body.replace(/\s+$/, "") : "";
    const event = {
      id,
      at: when,
      job_id,
      type,
      summary,
      has_body: text !== "",
      created_at: nowIso(),
    };
    validateEvent(event);
    if (text !== "") tx.write(eventBodyPath(id), `${text}\n`);
    state.events.push(event);
    return event;
  }

  /** Re-derive the cached status of a job from its latest status-changing event. */
  function recompute(state, job) {
    const last = state.events
      .filter((e) => e.job_id === job.source_id && isStatusEventType(e.type))
      .sort(compareEvents)
      .at(-1);
    if (!last) {
      job.status = "new";
      job.status_at = job.captured_at;
      job.auto_deleted = false;
      return;
    }
    job.status = statusForEvent(last.type);
    job.status_at = last.at;
    job.auto_deleted = job.status === "deleted" && isAutoSummary(last.summary);
  }

  function decorate(job, events, now) {
    const mine = events.filter((e) => e.job_id === job.source_id);
    const applied = job.status === "applied" ? appliedAt(mine) : "";
    return {
      ...job,
      applied_at: applied,
      no_reply: job.status === "applied" && isNoReply(mine, now),
    };
  }

  function requireJob(state, id) {
    const job = state.jobs.find((j) => j.source_id === id);
    if (!job) throw new NotFoundError(`No job "${id}"`);
    return job;
  }

  function checkEventType(type, allowed) {
    if (!allowed.includes(type)) throw new ValidationError(`Invalid event type "${type}"`);
  }

  async function withJobNames(events, state) {
    const byId = new Map(state.jobs.map((j) => [j.source_id, j]));
    return events.map((e) => {
      const job = byId.get(e.job_id);
      return { ...e, job_name: job?.name ?? "", job_company: job?.company ?? "" };
    });
  }

  return {
    dir,
    jobsPath,
    eventsPath,
    load,

    async health() {
      const [jobs, events] = await Promise.all([probeReadable(jobsPath), probeReadable(eventsPath)]);
      return { jobs, events };
    },

    async allEvents() {
      return (await load()).events;
    },

    async jobIds() {
      return (await load()).jobs.map((j) => j.source_id);
    },

    async listJobs({ status, q, auto_deleted } = {}, now = Date.now()) {
      const state = await load();
      const statuses = status ? status.split(",").filter(Boolean) : null;
      if (statuses && statuses.some((s) => !STATUSES.includes(s))) throw new ValidationError("Invalid status filter");
      const needle = (q ?? "").trim().toLowerCase();
      const byJob = Map.groupBy(state.events, (e) => e.job_id);
      return state.jobs
        .filter((j) => !statuses || statuses.includes(j.status))
        .filter((j) => auto_deleted === undefined || auto_deleted === "" || j.auto_deleted === (auto_deleted === "true"))
        .filter(
          (j) =>
            !needle ||
            [j.name, j.company, j.skills, j.locations, j.fit_primary_stack].some((v) => v.toLowerCase().includes(needle)),
        )
        .map((j) => decorate(j, byJob.get(j.source_id) ?? [], now))
        .sort((a, b) => (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : 0));
    },

    async getJob(id, now = Date.now()) {
      if (!isValidSourceId(id)) throw new NotFoundError(`No job "${id}"`);
      const state = await load();
      const job = requireJob(state, id);
      const events = state.events.filter((e) => e.job_id === id).sort((a, b) => compareEvents(b, a));
      const [posting, bodies] = await Promise.all([
        readText(postingPath(id)),
        Promise.all(events.map((e) => (e.has_body ? readBody(e.id) : ""))),
      ]);
      return {
        job: decorate(job, events, now),
        posting,
        events: events.map((e, i) => ({ ...e, body: bodies[i] })),
      };
    },

    /** Capture ingest. Idempotent on source_id: a known job is never rewritten or resurrected. */
    ingestJob(input) {
      return mutate((state, tx) => {
        const sourceId = str(input?.source_id).trim();
        if (!isValidSourceId(sourceId)) throw new ValidationError("source_id is required");
        const existing = state.jobs.find((j) => j.source_id === sourceId);
        if (existing) return { result: { created: false, job: existing } };

        const job = emptyJob();
        for (const field of JOB_INPUT_FIELDS) job[field] = str(input[field]).trim();
        job.source_id = sourceId;
        job.source = job.source || "Wellfound";
        if (!job.name) throw new ValidationError("name is required");
        const capturedAt = toIso(input.captured_at || nowIso());
        job.captured_at = capturedAt;
        job.status = "new";
        job.status_at = capturedAt;

        const auto = input.auto_deleted === true || input.auto_deleted === "true";
        const posting = str(input.posting).replace(/\s+$/, "");
        if (posting) tx.write(postingPath(sourceId), `${posting}\n`);

        pushEvent(state, tx, { at: capturedAt, job_id: sourceId, type: "captured" });
        let deleted = null;
        if (auto) {
          const requested = input.status_at ? toIso(input.status_at) : capturedAt;
          const at = requested > capturedAt ? requested : plusMs(capturedAt, 1);
          deleted = pushEvent(state, tx, {
            at,
            job_id: sourceId,
            type: "deleted",
            summary: autoSummary(input.auto_reason),
          });
          job.status = "deleted";
          job.status_at = deleted.at;
          job.auto_deleted = true;
        }
        validateJob(job);
        state.jobs.push(job);
        return { result: { created: true, job }, jobs: true, events: true };
      });
    },

    /** Move a job to `status`: one event (and optional message file) plus the row, in one write. */
    setStatus(id, { status, body = "", at } = {}) {
      return mutate((state, tx) => {
        if (!STATUSES.includes(status)) throw new ValidationError(`Invalid status "${status}"`);
        const job = requireJob(state, id);
        if (job.status === status) throw new ConflictError(`Job is already ${status}`);
        let when = at ? toIso(at) : nowIso();
        if (!at) {
          const latest = state.events
            .filter((e) => e.job_id === id)
            .reduce((max, e) => (e.at > max ? e.at : max), "");
          if (latest >= when) when = plusMs(latest, 1);
        }
        const event = pushEvent(state, tx, { at: when, job_id: id, type: eventTypeForStatus(status), body });
        recompute(state, job);
        return { result: { job: { ...job }, event }, jobs: true, events: true };
      });
    },

    async listEvents({ from, to, job_id, type, limit, offset = 0, bodies = false } = {}) {
      const state = await load();
      const types = type ? type.split(",").filter(Boolean) : null;
      if (types && types.some((t) => !ALL_EVENT_TYPES.includes(t))) throw new ValidationError("Invalid type filter");
      const filtered = state.events
        .filter((e) => !job_id || e.job_id === job_id)
        .filter((e) => !types || types.includes(e.type))
        .filter((e) => {
          if (!from && !to) return true;
          const day = localDate(e.at, tz);
          return (!from || day >= from) && (!to || day <= to);
        })
        .sort((a, b) => compareEvents(b, a));
      const page = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
      const named = await withJobNames(page, state);
      const withBodies = bodies
        ? await Promise.all(named.map(async (e) => ({ ...e, body: e.has_body ? await readBody(e.id) : "" })))
        : named;
      return { events: withBodies, total: filtered.length };
    },

    async getEvent(id) {
      if (!isValidEventId(id)) throw new NotFoundError("Event not found");
      const state = await load();
      const event = state.events.find((e) => e.id === id);
      if (!event) throw new NotFoundError("Event not found");
      const [named] = await withJobNames([event], state);
      return { ...named, body: event.has_body ? await readBody(id) : "" };
    },

    /** Manual entry (Log page). Status types also move the job. */
    createEvent(input) {
      return mutate((state, tx) => {
        const type = str(input?.type);
        checkEventType(type, MANUAL_EVENT_TYPES);
        const jobId = str(input.job_id).trim();
        if (isStatusEventType(type) && !jobId) throw new ValidationError(`${type} needs a job`);
        const job = jobId ? requireJob(state, jobId) : null;
        const event = pushEvent(state, tx, { at: input.at || nowIso(), job_id: jobId, type, body: str(input.body) });
        if (job && isStatusEventType(type)) recompute(state, job);
        return { result: event, jobs: Boolean(job && isStatusEventType(type)), events: true };
      });
    },

    updateEvent(id, patch) {
      return mutate((state, tx) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new NotFoundError("Event not found");
        if (!NOTE_EVENT_TYPES.includes(event.type)) {
          throw new ConflictError("Status and system events cannot be edited; delete them instead");
        }
        if ("type" in patch) {
          checkEventType(patch.type, NOTE_EVENT_TYPES);
          event.type = patch.type;
        }
        if ("at" in patch) event.at = toIso(patch.at);
        if ("job_id" in patch) {
          const jobId = str(patch.job_id).trim();
          if (jobId) requireJob(state, jobId);
          event.job_id = jobId;
        }
        if ("body" in patch) {
          const text = str(patch.body).replace(/\s+$/, "");
          if (text) tx.write(eventBodyPath(id), `${text}\n`);
          else if (event.has_body) tx.remove(eventBodyPath(id));
          event.has_body = text !== "";
        }
        validateEvent(event);
        return { result: event, events: true };
      });
    },

    /** Removes the CSV row and the message file. Deleting a status event re-derives the job's status. */
    deleteEvent(id) {
      return mutate((state, tx) => {
        const index = state.events.findIndex((e) => e.id === id);
        if (index < 0) throw new NotFoundError("Event not found");
        const [event] = state.events.splice(index, 1);
        let touchedJob = false;
        let job = null;
        if (event.job_id && isStatusEventType(event.type)) {
          job = state.jobs.find((j) => j.source_id === event.job_id) ?? null;
          if (job) {
            recompute(state, job);
            touchedJob = true;
          }
        }
        if (event.has_body) tx.remove(eventBodyPath(id));
        return { result: { deleted: id, job: job ? { ...job } : null }, jobs: touchedJob, events: true };
      });
    },

    /** One `pull` event with the run's counts (system-written, no job). */
    addPull({ summary, at }) {
      return mutate((state, tx) => ({
        result: pushEvent(state, tx, { at: at || nowIso(), type: "pull", summary }),
        events: true,
      }));
    },
  };
}
