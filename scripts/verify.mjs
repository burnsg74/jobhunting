// Checks an exported data dir. Usage:
//   node scripts/verify.mjs              vault data (production dir), compared with the old Postgres DB when reachable
//   node scripts/verify.mjs dev          data/dev, structure checks only
//   node scripts/verify.mjs --no-db      skip the Postgres comparison, use the migration brief's numbers
//
// The brief's expected numbers (captured 2026-09-19 to 2026-10-26): 139 jobs, 110 deleted / 27 applied /
// 2 rejected, 139 postings, events 139 captured / 30 applied / 110 deleted / 2 rejected, 49 auto-deleted.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "../backend/config.js";
import {
  EVENTS_FILE,
  JOBS_FILE,
  POSTINGS_DIR,
  compareEvents,
  isStatusEventType,
  isAutoSummary,
  parseEvents,
  parseJobs,
  statusForEvent,
} from "../backend/schema.js";

const args = process.argv.slice(2);
const dev = args.includes("dev");
const useDb = !dev && !args.includes("--no-db");
const config = resolveConfig({ ...process.env, NODE_ENV: "production" });
const dir = dev ? config.devDir : config.prodDir;

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
};
const countBy = (list, fn) => list.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] ?? 0) + 1), m), {});

console.log(`data: ${dir}`);
const jobs = parseJobs(readFileSync(path.join(dir, JOBS_FILE), "utf8"));
const events = parseEvents(readFileSync(path.join(dir, EVENTS_FILE), "utf8"));
const postingsDir = path.join(dir, POSTINGS_DIR);
const postings = existsSync(postingsDir) ? readdirSync(postingsDir).filter((f) => f.endsWith(".md")) : [];

const ids = new Set(jobs.map((j) => j.source_id));
const statuses = countBy(jobs, (j) => j.status);
const types = countBy(events, (e) => e.type);
const autoDeleted = jobs.filter((j) => j.auto_deleted).length;

console.log("rows:", jobs.length, "statuses:", statuses, "events:", types, "auto-deleted:", autoDeleted);

check("source_id unique", ids.size === jobs.length);
check("event ids unique", new Set(events.map((e) => e.id)).size === events.length);
check("one posting file per job", postings.length === jobs.length && jobs.every((j) => postings.includes(`${j.source_id}.md`)));
check("every event points at a known job (or is a pull)", events.every((e) => (e.job_id ? ids.has(e.job_id) : e.type === "pull" || e.type === "note" || e.type === "offer" || e.type === "withdrew")));
check("every job has one captured event", jobs.every((j) => events.filter((e) => e.job_id === j.source_id && e.type === "captured").length === 1));
check(
  "cached status matches latest status event",
  jobs.every((j) => {
    const last = events
      .filter((e) => e.job_id === j.source_id && isStatusEventType(e.type))
      .sort(compareEvents)
      .at(-1);
    return last && statusForEvent(last.type) === j.status && last.at === j.status_at;
  }),
);
check("auto_deleted jobs are deleted with an Auto: event", jobs.filter((j) => j.auto_deleted).every((j) => j.status === "deleted" && events.some((e) => e.job_id === j.source_id && e.type === "deleted" && isAutoSummary(e.summary))));
check("events with a body have a file", events.filter((e) => e.has_body).every((e) => existsSync(path.join(dir, "events", `${e.id}.md`))));

if (!dev) {
  let expected = {
    jobs: 139,
    postings: 139,
    statuses: { deleted: 110, applied: 27, rejected: 2 },
    events: { captured: 139, applied: 30, deleted: 110, rejected: 2 },
    auto: 49,
  };

  if (useDb) {
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgres://greg@localhost:5432/jobs" });
      const { rows } = await pool.query("SELECT status, applied_at, deleted_auto, source_id FROM jobs");
      await pool.end();
      const map = { interview: "interviewing", no_response: "applied" };
      const st = countBy(rows, (r) => map[r.status] ?? r.status);
      const everApplied = rows.filter((r) => r.applied_at || ["applied", "interview", "rejected", "no_response"].includes(r.status)).length;
      expected = {
        jobs: rows.length,
        postings: rows.length,
        statuses: st,
        events: {
          captured: rows.length,
          applied: everApplied,
          deleted: st.deleted ?? 0,
          rejected: st.rejected ?? 0,
          ...(st.interviewing ? { interviewing: st.interviewing } : {}),
          ...(st.saved ? { saved: st.saved } : {}),
        },
        auto: rows.filter((r) => r.deleted_auto).length,
      };
      console.log("expected from Postgres:", expected);
    } catch (error) {
      console.warn(`Postgres not reachable (${error.message}); using the brief's numbers.`);
    }
  }

  check(`${expected.jobs} jobs`, jobs.length === expected.jobs, String(jobs.length));
  check(`${expected.postings} posting files`, postings.length === expected.postings, String(postings.length));
  for (const [status, n] of Object.entries(expected.statuses)) check(`status ${status} = ${n}`, (statuses[status] ?? 0) === n, String(statuses[status] ?? 0));
  check("no unexpected statuses", Object.keys(statuses).every((s) => s in expected.statuses));
  for (const [type, n] of Object.entries(expected.events)) check(`${type} events = ${n}`, (types[type] ?? 0) === n, String(types[type] ?? 0));
  check(`${expected.auto} auto-deleted`, autoDeleted === expected.auto, String(autoDeleted));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
