// One-shot export.
//
//   node scripts/export-from-postgres.mjs prod [--force]   Postgres `jobs` DB -> vault 10 Projects/Job Hunting/data/
//   node scripts/export-from-postgres.mjs dev  [--force]   synthetic sample (no DB needed) -> repo data/dev/
//
// prod writes jobs.csv, postings/{source_id}.md, events.csv and an empty events/ folder, with events
// backfilled from the old status columns so the reports have history. It refuses to overwrite without --force.
// dev builds a made-up data set through the real store, so the committed sample is always schema-valid.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "../backend/config.js";
import {
  EVENTS_DIR,
  EVENTS_FILE,
  JOBS_FILE,
  POSTINGS_DIR,
  autoSummary,
  compareEvents,
  emptyJob,
  isStatusEventType,
  statusForEvent,
  stringifyEvents,
  stringifyJobs,
} from "../backend/schema.js";
import { createStore, newEventId } from "../backend/store.js";
import { DEFAULT_TZ } from "../backend/tz.js";

const [mode, ...flags] = process.argv.slice(2);
const force = flags.includes("--force");

if (mode !== "prod" && mode !== "dev") {
  console.error("usage: export-from-postgres.mjs <prod|dev> [--force]");
  process.exit(1);
}

const config = resolveConfig({ ...process.env, NODE_ENV: "production" });
const outDir = mode === "prod" ? config.prodDir : config.devDir;
const outputs = [JOBS_FILE, EVENTS_FILE, POSTINGS_DIR, EVENTS_DIR].map((f) => path.join(outDir, f));

if (!force && outputs.some(existsSync)) {
  console.error(`Refusing to overwrite existing data in ${outDir} (pass --force).`);
  process.exit(1);
}

function fail(message) {
  console.error(`export failed: ${message}`);
  process.exit(1);
}

const plusMs = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

function clearOutputs() {
  for (const target of outputs) rmSync(target, { recursive: true, force: true });
  mkdirSync(path.join(outDir, POSTINGS_DIR), { recursive: true });
  mkdirSync(path.join(outDir, EVENTS_DIR), { recursive: true });
}

if (mode === "dev") {
  await exportDev();
} else {
  await exportProd();
}

// ---- prod -------------------------------------------------------------------

async function exportProd() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgres://greg@localhost:5432/jobs" });
  const { rows } = await pool.query("SELECT * FROM jobs ORDER BY captured_at, id");
  await pool.end();

  const ids = rows.map((r) => r.source_id);
  if (new Set(ids).size !== ids.length) fail("Duplicate source_id values.");

  // Old `created_at` is only a fallback for a missing or unparseable captured_at.
  const isoOrNull = (value) => {
    if (value instanceof Date) return value.toISOString();
    const t = Date.parse(String(value ?? ""));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };

  const statusMap = { interview: "interviewing", no_response: "applied" };
  const jobs = [];
  const events = [];
  const taken = new Set();
  const bodies = [];
  const warnings = [];

  const addEvent = (job, at, type, summary = "") => {
    const id = newEventId(at, taken, DEFAULT_TZ);
    taken.add(id);
    events.push({ id, at, job_id: job.source_id, type, summary, has_body: false, created_at: at });
  };

  for (const r of rows) {
    const job = emptyJob();
    for (const col of Object.keys(job)) if (typeof r[col] === "string") job[col] = r[col];
    job.source_id = r.source_id;
    job.source = r.source || "Wellfound";
    const capturedAt = isoOrNull(r.captured_at) ?? isoOrNull(r.created_at);
    if (!capturedAt) fail(`Job ${r.source_id} has no usable captured_at.`);
    job.captured_at = capturedAt;
    const status = statusMap[r.status] ?? r.status;
    job.status = status;
    job.auto_deleted = Boolean(r.deleted_auto);

    // History: captured, then applied (if ever), then the final status. Each strictly later than the last.
    let cursor = capturedAt;
    addEvent(job, capturedAt, "captured");
    const statusAt = isoOrNull(r.status_updated_at);
    const appliedAtRaw = isoOrNull(r.applied_at);
    const everApplied = Boolean(appliedAtRaw) || ["applied", "interviewing", "rejected"].includes(status);

    if (everApplied) {
      let at = appliedAtRaw ?? statusAt ?? plusMs(cursor, 1);
      if (at <= cursor) at = plusMs(cursor, 1);
      addEvent(job, at, "applied");
      cursor = at;
      job.status_at = at;
    }
    if (status === "deleted" || status === "interviewing" || status === "rejected" || status === "saved") {
      let at = statusAt ?? plusMs(cursor, 1);
      if (at <= cursor) at = plusMs(cursor, 1);
      const summary = status === "deleted" && job.auto_deleted ? autoSummary(r.deleted_reason) : "";
      addEvent(job, at, status, summary);
      cursor = at;
      job.status_at = at;
    }
    if (status === "new") job.status_at = capturedAt;
    if (status === "applied" && !job.status_at) job.status_at = cursor;
    if (!everApplied && status === "applied") warnings.push(`${r.source_id}: applied without a date`);

    // Old manual delete reasons, missing_skills, early-exit, required-match etc. are dropped by design.
    jobs.push(job);
    bodies.push([r.source_id, String(r.body ?? "").replace(/\s+$/, "")]);
  }

  // Sanity: each job's cached status must equal the status derived from its events.
  for (const job of jobs) {
    const last = events
      .filter((e) => e.job_id === job.source_id && isStatusEventType(e.type))
      .sort(compareEvents)
      .at(-1);
    if (statusForEvent(last.type) !== job.status) fail(`${job.source_id}: events end in ${last.type}, row says ${job.status}`);
  }

  events.sort(compareEvents);
  clearOutputs();
  for (const [id, body] of bodies) {
    writeFileSync(path.join(outDir, POSTINGS_DIR, `${id}.md`), body ? `${body}\n` : "");
  }
  writeFileSync(path.join(outDir, JOBS_FILE), stringifyJobs(jobs));
  writeFileSync(path.join(outDir, EVENTS_FILE), stringifyEvents(events));

  const count = (list, key) => list.reduce((m, x) => m.set(x[key], (m.get(x[key]) ?? 0) + 1), new Map());
  console.log(`prod: wrote ${jobs.length} jobs, ${bodies.length} postings, ${events.length} events -> ${outDir}`);
  console.log("statuses:", Object.fromEntries(count(jobs, "status")));
  console.log("events:  ", Object.fromEntries(count(events, "type")));
  console.log("auto-deleted:", jobs.filter((j) => j.auto_deleted).length);
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log("Next: npm run verify");
}

// ---- dev --------------------------------------------------------------------

async function exportDev() {
  clearOutputs();
  const store = createStore(outDir);
  let seed = 4002;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const DAY = 86_400_000;
  const now = Date.now();
  const ago = (days, hours = 0) => new Date(now - days * DAY - hours * 3_600_000).toISOString();

  const companies = ["Acme Labs", "Northwind Software", "Globex Systems", "Initech Cloud", "Umbrella Apps", "Hooli Works", "Stark Data", "Wayne Tools", "Pied Piper", "Soylent Tech", "Vandelay Digital", "Tyrell Cloud"];
  const titles = ["Senior Full Stack Engineer", "Staff Software Engineer", "Founding Engineer", "Product Engineer", "Senior Backend Engineer", "Frontend Engineer", "Platform Engineer"];
  const skillSets = [
    "TypeScript, React, Node.js, PostgreSQL",
    "Python, Django, PostgreSQL, AWS",
    "JavaScript, Svelte, Node.js, GraphQL",
    "Ruby on Rails, PostgreSQL, Redis",
    "TypeScript, Next.js, Tailwind, Prisma",
    "Go, Kubernetes, Terraform",
  ];
  const comps = ["$140k – $180k", "$160k – $200k", "$120k – $150k", "$180k – $230k", "", "$100k – $130k"];
  const recs = ["STRONG_PASS", "PASS", "PASS", "HOLD"];

  const posting = (title, company) =>
    [
      `# ${title} at ${company}`,
      "",
      `${company} builds software for teams that move fast. This is a made-up sample posting used for development.`,
      "",
      "## What you'll do",
      "",
      "- Ship features end to end across the stack",
      "- Work with a small team and own what you build",
      "- Talk to customers and turn feedback into product",
      "",
      "## What we're looking for",
      "",
      "- 5+ years building production web applications",
      "- Comfortable with TypeScript and SQL",
      "- Clear written communication",
    ].join("\n");

  const make = (n, over = {}) => {
    const company = companies[n % companies.length];
    const title = titles[n % titles.length];
    const recommendation = pick(recs);
    const overall = (0.55 + rand() * 0.4).toFixed(2);
    return {
      source_id: String(9_000_000 + n),
      source: "Wellfound",
      name: title,
      company,
      url: `https://example.com/jobs/${9_000_000 + n}-sample`,
      company_url: `https://example.com/company/${company.toLowerCase().replaceAll(" ", "-")}`,
      compensation: comps[n % comps.length],
      equity: n % 3 === 0 ? "0.1% – 0.5%" : "",
      job_type: "full-time",
      remote: n % 5 === 4 ? "false" : "true",
      experience_min: String(3 + (n % 4)),
      skills: skillSets[n % skillSets.length],
      locations: n % 5 === 4 ? "Austin, TX" : "Remote (US)",
      posted_at: ago(2 + (n % 20)),
      captured_at: ago(1 + (n % 12), n % 7),
      fit_score: String(5 + Math.floor(rand() * 5)),
      fit_recommendation: recommendation,
      fit_overall_match: overall,
      fit_primary_stack: skillSets[n % skillSets.length].split(", ").slice(0, 2).join(", "),
      fit_summary: `Sample fit summary: Greg's stack lines up with ${company}'s role. Compensation and remote policy look reasonable.`,
      fit_have_skills: skillSets[n % skillSets.length].split(", ").slice(0, 3).join(", "),
      fit_familiar_skills: "GraphQL",
      fit_dont_have_skills: n % 4 === 0 ? "Kubernetes" : "",
      fit_model: "claude-haiku-4-5",
      fit_evaluated_at: ago(1),
      posting: posting(title, company),
      ...over,
    };
  };

  // 22 jobs. 0-9 stay in the inbox, then saved, applied, interviewing, rejected and deleted ones.
  // Jobs that get triaged were captured well before their events.
  for (let n = 0; n < 22; n++) await store.ingestJob(make(n, n >= 10 && n <= 17 ? { captured_at: ago(40 + n) } : {}));
  await store.ingestJob(make(22, { auto_deleted: true, auto_reason: "wrong_location", remote: "false", fit_recommendation: "SKIP", fit_score: "2", fit_overall_match: "0.30" }));
  await store.ingestJob(make(23, { auto_deleted: true, auto_reason: "compensation", fit_recommendation: "SKIP", fit_score: "1", fit_overall_match: "0.40", compensation: "$60k – $80k" }));
  await store.ingestJob(make(24, { fit_recommendation: "", fit_score: "", fit_overall_match: "", fit_summary: "", fit_have_skills: "", fit_familiar_skills: "", fit_dont_have_skills: "", fit_model: "", fit_evaluated_at: "", fit_error: "no_api_key" }));

  const id = (n) => String(9_000_000 + n);
  const to = (n, status, at) => store.setStatus(id(n), { status, at });

  for (const n of [10, 11, 12]) await to(n, "saved", ago(3, n));
  await to(13, "applied", ago(21));
  await to(14, "applied", ago(9));
  await to(15, "applied", ago(5));
  await to(16, "applied", ago(30));
  await to(16, "interviewing", ago(24));
  await to(17, "applied", ago(18));
  await to(17, "rejected", ago(11));
  for (const [n, d] of [[18, 6], [19, 4], [20, 2], [21, 1]]) await to(n, "deleted", ago(d));

  await store.createEvent({
    type: "note",
    job_id: id(15),
    at: ago(5, 1),
    body: [
      "## Why do you want to work here?",
      "",
      "Sample answer: I like **small teams** that ship quickly, and the product is close to the problems I have worked on.",
      "",
      "## Describe a project you are proud of",
      "",
      "- Built a CSV-backed budgeting app",
      "- Kept the data in plain files",
    ].join("\n"),
  });
  await store.createEvent({ type: "offer", job_id: id(16), at: ago(2), body: "Verbal offer, waiting on the written details." });
  await store.createEvent({ type: "note", at: ago(1, 3), body: "General note: update the resume before the next batch of applications." });
  await store.addPull({ at: ago(1), summary: "Pull: 25 new, 4 known, 0 failed" });

  const files = readdirSync(path.join(outDir, POSTINGS_DIR)).length;
  console.log(`dev: wrote 25 jobs, ${files} postings -> ${outDir}`);
}
