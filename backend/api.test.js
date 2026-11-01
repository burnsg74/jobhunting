import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createApp } from "./server.js";
import { createPulls } from "./pulls.js";
import { createStore } from "./store.js";

let dir;
let server;
let base;
let pulls;

const config = () => ({ mode: "development", dir, port: 0, repoRoot: dir, apiUrl: "http://127.0.0.1:0", promptFile: "" });

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const job = (id, over = {}) => ({
  source_id: id,
  name: `Engineer ${id}`,
  company: "Acme",
  url: `https://example.com/jobs/${id}`,
  remote: "true",
  skills: "TypeScript",
  captured_at: "2026-10-01T12:00:00.000Z",
  posting: `# Posting ${id}\n\nHello.`,
  ...over,
});

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "jobhunting-"));
  const store = createStore(dir);
  pulls = createPulls({
    config: config(),
    store,
    command: {
      cmd: process.execPath,
      cwd: dir,
      args: [
        "-e",
        `const l=(o)=>console.log(JSON.stringify(o));
         l({event:"listing",total:3});
         l({event:"saved",index:1,total:3,id:"a",name:"A"});
         l({event:"skip",index:2,total:3,id:"b"});
         console.log("plain log line");
         l({event:"failed",index:3,total:3,id:"c",error:"boom"});
         l({event:"done",new:1,known:1,failed:1});`,
      ],
    },
  });
  server = createApp(config(), store, pulls);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("health", () => {
  test("empty data dir is healthy", async () => {
    const { status, body } = await call("GET", "/api/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });
});

describe("ingest", () => {
  test("creates job, posting file and captured event; is idempotent", async () => {
    const first = await call("POST", "/api/jobs", job("100"));
    assert.equal(first.status, 201);
    assert.equal(first.body.created, true);
    assert.equal(first.body.job.status, "new");
    assert.ok(existsSync(path.join(dir, "postings", "100.md")));

    const again = await call("POST", "/api/jobs", job("100", { name: "Changed" }));
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);

    const detail = (await call("GET", "/api/jobs/100")).body;
    assert.equal(detail.job.name, "Engineer 100");
    assert.match(detail.posting, /Posting 100/);
    assert.deepEqual(detail.events.map((e) => e.type), ["captured"]);
    assert.deepEqual((await call("GET", "/api/jobs/ids")).body.ids, ["100"]);
  });

  test("auto-deleted jobs get a deleted event and are never resurrected", async () => {
    const { body } = await call("POST", "/api/jobs", job("101", { auto_deleted: true, auto_reason: "wrong_location" }));
    assert.equal(body.job.status, "deleted");
    assert.equal(body.job.auto_deleted, true);
    const { events } = (await call("GET", "/api/jobs/101")).body;
    assert.deepEqual(events.map((e) => [e.type, e.summary]).reverse(), [
      ["captured", ""],
      ["deleted", "Auto: wrong location"],
    ]);
    await call("POST", "/api/jobs", job("101"));
    assert.equal((await call("GET", "/api/jobs/101")).body.job.status, "deleted");
    const auto = (await call("GET", "/api/jobs?status=deleted&auto_deleted=true")).body.jobs;
    assert.deepEqual(auto.map((j) => j.source_id), ["101"]);
  });

  test("validates input", async () => {
    assert.equal((await call("POST", "/api/jobs", { name: "x" })).status, 400);
    assert.equal((await call("POST", "/api/jobs", { source_id: "../etc" , name: "x"})).status, 400);
    assert.equal((await call("GET", "/api/jobs/nope")).status, 404);
  });
});

describe("status and undo", () => {
  test("status change writes one event and updates the row; deleting the event undoes it", async () => {
    await call("POST", "/api/jobs", job("200"));
    const saved = await call("POST", "/api/jobs/200/status", { status: "saved" });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.job.status, "saved");

    const applied = await call("POST", "/api/jobs/200/status", { status: "applied" });
    assert.equal(applied.body.job.status, "applied");

    const undone = await call("DELETE", `/api/events/${applied.body.event.id}`);
    assert.equal(undone.status, 200);
    assert.equal(undone.body.job.status, "saved");
    assert.equal((await call("GET", "/api/jobs/200")).body.job.status, "saved");

    const again = await call("DELETE", `/api/events/${saved.body.event.id}`);
    assert.equal(again.body.job.status, "new");
  });

  test("rejects invalid and no-op statuses", async () => {
    await call("POST", "/api/jobs", job("201"));
    assert.equal((await call("POST", "/api/jobs/201/status", { status: "bogus" })).status, 400);
    assert.equal((await call("POST", "/api/jobs/201/status", { status: "new" })).status, 409);
    assert.equal((await call("POST", "/api/jobs/missing/status", { status: "saved" })).status, 404);
  });

  test("message body goes to events/{id}.md and is removed with the event", async () => {
    await call("POST", "/api/jobs", job("202"));
    const { body } = await call("POST", "/api/jobs/202/status", { status: "applied", body: "## Q\n\nA" });
    const file = path.join(dir, "events", `${body.event.id}.md`);
    assert.equal(await readFile(file, "utf8"), "## Q\n\nA\n");
    assert.equal(body.event.has_body, true);
    await call("DELETE", `/api/events/${body.event.id}`);
    assert.equal(existsSync(file), false);
  });

  test("restore sends a deleted job back to the inbox", async () => {
    await call("POST", "/api/jobs", job("203"));
    await call("POST", "/api/jobs/203/status", { status: "deleted" });
    const restored = await call("POST", "/api/jobs/203/status", { status: "new" });
    assert.equal(restored.body.job.status, "new");
    assert.equal(restored.body.event.type, "restored");
  });

  test("a backdated status event is ordered by time, not by when it was written", async () => {
    await call("POST", "/api/jobs", job("204"));
    await call("POST", "/api/jobs/204/status", { status: "rejected" });
    // Applied "yesterday" is earlier than the rejection, so the job stays rejected.
    await call("POST", "/api/events", { type: "applied", job_id: "204", at: "2026-10-02T12:00:00.000Z" });
    assert.equal((await call("GET", "/api/jobs/204")).body.job.status, "rejected");
  });
});

describe("events", () => {
  test("manual events: create, edit, delete; status events cannot be edited", async () => {
    await call("POST", "/api/jobs", job("300"));
    const note = await call("POST", "/api/events", { type: "note", job_id: "300", body: "Hello **world**", at: "2026-10-05T10:00:00Z" });
    assert.equal(note.status, 201);
    assert.equal(note.body.at, "2026-10-05T10:00:00.000Z");

    const edited = await call("PATCH", `/api/events/${note.body.id}`, { body: "Changed", type: "offer" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.type, "offer");
    assert.equal((await call("GET", `/api/events/${note.body.id}`)).body.body, "Changed\n");

    const cleared = await call("PATCH", `/api/events/${note.body.id}`, { body: "" });
    assert.equal(cleared.body.has_body, false);
    assert.equal(existsSync(path.join(dir, "events", `${note.body.id}.md`)), false);

    const status = await call("POST", "/api/events", { type: "saved", job_id: "300" });
    assert.equal((await call("PATCH", `/api/events/${status.body.id}`, { body: "x" })).status, 409);
    assert.equal((await call("GET", "/api/jobs/300")).body.job.status, "saved");

    assert.equal((await call("DELETE", `/api/events/${note.body.id}`)).status, 200);
    assert.equal((await call("DELETE", `/api/events/${note.body.id}`)).status, 404);
  });

  test("validation: status types need a job, captured/pull are not manual", async () => {
    assert.equal((await call("POST", "/api/events", { type: "saved" })).status, 400);
    assert.equal((await call("POST", "/api/events", { type: "captured", job_id: "300" })).status, 400);
    assert.equal((await call("POST", "/api/events", { type: "pull" })).status, 400);
    assert.equal((await call("POST", "/api/events", { type: "note", job_id: "nope" })).status, 404);
    assert.equal((await call("POST", "/api/events", { type: "note", at: "yesterday" })).status, 400);
  });

  test("list filters by job, type and local date; paging and bodies", async () => {
    await call("POST", "/api/jobs", job("301", { captured_at: "2026-10-10T08:00:00.000Z" }));
    await call("POST", "/api/events", { type: "note", job_id: "301", body: "late", at: "2026-10-11T06:59:00.000Z" }); // Oct 10 23:59 PDT
    await call("POST", "/api/events", { type: "note", job_id: "301", body: "early", at: "2026-10-11T07:01:00.000Z" }); // Oct 11 00:01 PDT

    const day10 = (await call("GET", "/api/events?job_id=301&from=2026-10-10&to=2026-10-10&bodies=1")).body.events;
    assert.deepEqual(day10.map((e) => e.type), ["note", "captured"]);
    assert.equal(day10[0].body, "late\n");
    assert.equal(day10[0].job_name, "Engineer 301");
    const day11 = (await call("GET", "/api/events?job_id=301&from=2026-10-11&to=2026-10-11")).body;
    assert.equal(day11.events.length, 1);
    assert.equal(day11.events[0].body, undefined);

    const page = (await call("GET", "/api/events?job_id=301&limit=1&offset=1")).body;
    assert.equal(page.total, 3);
    assert.equal(page.events.length, 1);
    assert.equal((await call("GET", "/api/events?type=nope")).status, 400);
    assert.equal((await call("GET", "/api/events?from=10/10/2026")).status, 400);
  });
});

describe("jobs list", () => {
  test("filters by status and search; flags no reply after 14 days", async () => {
    await call("POST", "/api/jobs", job("400", { name: "Unique Zebra Role", captured_at: "2025-12-01T00:00:00Z" }));
    await call("POST", "/api/jobs/400/status", { status: "applied", at: "2026-01-01T00:00:00Z" });
    const applied = (await call("GET", "/api/jobs?status=applied")).body.jobs.find((j) => j.source_id === "400");
    assert.equal(applied.no_reply, true);
    assert.equal(applied.applied_at, "2026-01-01T00:00:00.000Z");

    // Any later event for the job clears the badge.
    await call("POST", "/api/events", { type: "note", job_id: "400", at: "2026-01-02T00:00:00Z" });
    const after = (await call("GET", "/api/jobs?status=applied&q=zebra")).body.jobs;
    assert.equal(after.length, 1);
    assert.equal(after[0].no_reply, false);
    assert.equal((await call("GET", "/api/jobs?status=bogus")).status, 400);
    assert.equal((await call("GET", "/api/jobs?q=nomatchatall")).body.jobs.length, 0);
  });
});

describe("reports", () => {
  test("daily report buckets by local day and zero-fills", async () => {
    const { status, body } = await call("GET", "/api/reports/daily?from=2026-10-09&to=2026-10-12");
    assert.equal(status, 200);
    assert.deepEqual(body.days.map((d) => d.date), ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
    assert.equal(body.days[1].new_jobs, 1); // job 301 captured Oct 10 01:00 PDT
  });

  test("rejects bad ranges", async () => {
    assert.equal((await call("GET", "/api/reports/daily?from=2026-10-12&to=2026-10-09")).status, 400);
    assert.equal((await call("GET", "/api/reports/daily?from=nope")).status, 400);
    assert.equal((await call("GET", "/api/reports/daily")).body.days.length, 14);
  });
});

describe("pulls", () => {
  test("runs the script, tracks counts, writes a pull event", async () => {
    const start = await call("POST", "/api/pulls");
    assert.equal(start.status, 202);
    assert.equal(start.body.run.status, "running");
    assert.equal((await call("POST", "/api/pulls")).status, 409);

    let run;
    for (let i = 0; i < 100; i++) {
      run = (await call("GET", "/api/pulls/current")).body.run;
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(run.status, "done");
    assert.deepEqual([run.total, run.new, run.known, run.failed], [3, 1, 1, 1]);
    assert.ok(run.log.includes("plain log line"));

    const events = (await call("GET", "/api/events?type=pull")).body.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Pull: 1 new, 1 known, 1 failed");
  });

  test("cancel stops a long run and records it", async () => {
    const store = createStore(dir);
    const slow = createPulls({
      config: config(),
      store,
      command: {
        cmd: process.execPath,
        cwd: dir,
        args: ["-e", `console.log(JSON.stringify({event:"listing",total:9}));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)`],
      },
    });
    await slow.start();
    await new Promise((r) => setTimeout(r, 300));
    slow.cancel();
    await slow.shutdown();
    for (let i = 0; i < 100 && slow.current().status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(slow.current().status, "cancelled");
    const summaries = (await call("GET", "/api/events?type=pull")).body.events.map((e) => e.summary);
    assert.ok(summaries.includes("Pull cancelled: 0 new, 0 known, 0 failed"));
  });
});
