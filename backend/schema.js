// Column lists, enums, validation and (de)serialization for jobs.csv and events.csv.
import { parseCsvObjects, stringifyCsv } from "./csv.js";

export class ValidationError extends Error {}

export const JOBS_FILE = "jobs.csv";
export const EVENTS_FILE = "events.csv";
export const POSTINGS_DIR = "postings";
export const EVENTS_DIR = "events";

export const STATUSES = ["new", "saved", "applied", "deleted", "interviewing", "rejected"];

export const JOB_COLUMNS = [
  "source_id",
  "source",
  "name",
  "company",
  "url",
  "company_url",
  "compensation",
  "equity",
  "job_type",
  "remote",
  "experience_min",
  "skills",
  "locations",
  "posted_at",
  "captured_at",
  "status",
  "status_at",
  "auto_deleted",
  "fit_score",
  "fit_recommendation",
  "fit_overall_match",
  "fit_primary_stack",
  "fit_summary",
  "fit_have_skills",
  "fit_familiar_skills",
  "fit_dont_have_skills",
  "fit_model",
  "fit_evaluated_at",
  "fit_error",
];

export const EVENT_COLUMNS = ["id", "at", "job_id", "type", "summary", "has_body", "created_at"];

// Event types that change a job's status. The value is the status the event moves the job to.
// `captured` puts a job in the inbox; `restored` sends one back there (Restore button, status menu).
export const STATUS_EVENT_TYPES = {
  captured: "new",
  restored: "new",
  saved: "saved",
  applied: "applied",
  deleted: "deleted",
  interviewing: "interviewing",
  rejected: "rejected",
};

// Record-only types.
export const NOTE_EVENT_TYPES = ["offer", "withdrew", "note"];

// Types the Log page and API let you write by hand. `captured` and `pull` only come from a pull.
export const MANUAL_EVENT_TYPES = [
  "saved",
  "applied",
  "deleted",
  "interviewing",
  "rejected",
  "restored",
  ...NOTE_EVENT_TYPES,
];

export const ALL_EVENT_TYPES = [...Object.keys(STATUS_EVENT_TYPES), ...NOTE_EVENT_TYPES, "pull"];

export const isStatusEventType = (type) => Object.hasOwn(STATUS_EVENT_TYPES, type);

/** Status a given event type moves a job to, or the status name itself. */
export function statusForEvent(type) {
  return STATUS_EVENT_TYPES[type] ?? null;
}

/** Event type written when a job is moved to `status`. */
export function eventTypeForStatus(status) {
  return status === "new" ? "restored" : status;
}

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const EVENT_ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

export const isValidSourceId = (id) => typeof id === "string" && SOURCE_ID_RE.test(id);
export const isValidEventId = (id) => typeof id === "string" && EVENT_ID_RE.test(id);

export function assertIso(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${label} must be an ISO timestamp`);
  }
}

/** Normalize any parseable timestamp to ISO UTC with milliseconds. */
export function toIso(value) {
  assertIso(value, "timestamp");
  return new Date(value).toISOString();
}

export function emptyJob() {
  const job = {};
  for (const column of JOB_COLUMNS) job[column] = "";
  job.status = "new";
  job.auto_deleted = false;
  return job;
}

export function validateJob(job) {
  if (!isValidSourceId(job.source_id)) throw new ValidationError("source_id is required (letters, digits, - and _)");
  if (!STATUSES.includes(job.status)) throw new ValidationError(`Invalid status "${job.status}"`);
  for (const column of JOB_COLUMNS) {
    if (column === "auto_deleted") continue;
    if (typeof job[column] !== "string") throw new ValidationError(`${column} must be a string`);
  }
}

export function validateEvent(event) {
  if (!isValidEventId(event.id)) throw new ValidationError("Invalid event id");
  if (!ALL_EVENT_TYPES.includes(event.type)) throw new ValidationError(`Invalid event type "${event.type}"`);
  assertIso(event.at, "at");
  assertIso(event.created_at, "created_at");
}

export function parseJobs(text) {
  return parseCsvObjects(text).map((row) => ({
    ...row,
    auto_deleted: row.auto_deleted === "true",
  }));
}

export function stringifyJobs(jobs) {
  return stringifyCsv(
    JOB_COLUMNS,
    jobs.map((job) => JOB_COLUMNS.map((column) => (column === "auto_deleted" ? (job.auto_deleted ? "true" : "false") : job[column]))),
  );
}

export function parseEvents(text) {
  return parseCsvObjects(text).map((row) => ({
    ...row,
    has_body: row.has_body === "true",
  }));
}

export function stringifyEvents(events) {
  return stringifyCsv(
    EVENT_COLUMNS,
    events.map((event) => EVENT_COLUMNS.map((column) => (column === "has_body" ? (event.has_body ? "true" : "false") : event[column]))),
  );
}

// Order in which events happened. Ties break so `captured` precedes anything else at the same instant.
export function compareEvents(a, b) {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  const rank = (e) => (e.type === "captured" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const isAutoSummary = (summary) => typeof summary === "string" && summary.startsWith("Auto:");

/** `Auto: wrong location` from a fit delete reason such as `wrong_location`. */
export function autoSummary(reason) {
  const text = String(reason ?? "").replaceAll("_", " ").trim();
  return `Auto: ${text || "screened out"}`;
}

export const NO_REPLY_MS = 14 * 24 * 60 * 60 * 1000;

/** When the job was last applied to, from that job's events (`""` if never). */
export function appliedAt(jobEvents) {
  let latest = "";
  for (const e of jobEvents) if (e.type === "applied" && e.at > latest) latest = e.at;
  return latest;
}

/** Applied 14+ days ago and nothing logged for the job since. */
export function isNoReply(jobEvents, now = Date.now()) {
  const applied = appliedAt(jobEvents);
  if (!applied) return false;
  if (jobEvents.some((e) => e.at > applied)) return false;
  return now - Date.parse(applied) >= NO_REPLY_MS;
}
