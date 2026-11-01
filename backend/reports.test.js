import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dailyReport, defaultRange } from "./reports.js";
import { addDays, eachDay, localDate, localStamp } from "./tz.js";

const TZ = "America/Los_Angeles";
const ev = (at, type, extra = {}) => ({ id: `${at}-${type}`, at, type, job_id: "1", summary: "", ...extra });

describe("local days", () => {
  test("midnight boundaries in PDT and PST", () => {
    assert.equal(localDate("2026-10-10T06:59:59Z", TZ), "2026-10-09"); // 23:59:59 PDT
    assert.equal(localDate("2026-10-10T07:00:00Z", TZ), "2026-10-10"); // 00:00 PDT
    assert.equal(localDate("2026-12-01T07:59:59Z", TZ), "2026-11-30"); // 23:59:59 PST
    assert.equal(localDate("2026-12-01T08:00:00Z", TZ), "2026-12-01"); // 00:00 PST
  });

  test("fall back (2026-11-01, 25 hours) stays one day", () => {
    assert.equal(localDate("2026-11-01T06:59:00Z", TZ), "2026-10-31");
    assert.equal(localDate("2026-11-01T07:00:00Z", TZ), "2026-11-01");
    assert.equal(localDate("2026-11-01T09:30:00Z", TZ), "2026-11-01"); // 01:30 PST, the repeated hour
    assert.equal(localDate("2026-11-02T07:59:00Z", TZ), "2026-11-01"); // 23:59 PST
    assert.equal(localDate("2026-11-02T08:00:00Z", TZ), "2026-11-02");
  });

  test("spring forward (2026-03-08, 23 hours)", () => {
    assert.equal(localDate("2026-03-08T07:59:00Z", TZ), "2026-03-07");
    assert.equal(localDate("2026-03-08T08:00:00Z", TZ), "2026-03-08");
    assert.equal(localDate("2026-03-09T06:59:00Z", TZ), "2026-03-08"); // 23:59 PDT
    assert.equal(localDate("2026-03-09T07:00:00Z", TZ), "2026-03-09");
  });

  test("calendar day math ignores DST and month ends", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.deepEqual(eachDay("2026-10-31", "2026-11-02"), ["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  test("event id stamp is local wall time", () => {
    assert.equal(localStamp("2026-10-31T20:04:12Z", TZ), "20261031-130412");
    assert.equal(localStamp("2026-11-01T07:00:00Z", TZ), "20261101-000000");
  });
});

describe("dailyReport", () => {
  const range = { from: "2026-10-30", to: "2026-11-02" };

  test("counts each type by local day; zero-fills empty days", () => {
    const events = [
      ev("2026-10-31T10:00:00Z", "captured"),
      ev("2026-10-31T10:00:00Z", "captured"),
      ev("2026-10-31T10:00:01Z", "deleted", { summary: "Auto: wrong location" }),
      ev("2026-10-31T11:00:00Z", "saved"),
      ev("2026-10-31T12:00:00Z", "applied"),
      ev("2026-10-31T13:00:00Z", "deleted"),
      ev("2026-11-02T07:59:00Z", "interviewing"), // Nov 1 local
      ev("2026-11-02T08:00:00Z", "rejected"), // Nov 2 local
      ev("2026-11-02T08:00:00Z", "note"),
      ev("2026-11-02T08:00:00Z", "pull"),
      ev("2026-10-29T10:00:00Z", "captured"), // out of range
    ];
    const report = dailyReport(events, range, TZ);
    assert.deepEqual(report.days.map((d) => d.date), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    const [d30, d31, d01, d02] = report.days;
    assert.deepEqual(d30, { date: "2026-10-30", new_jobs: 0, auto_deleted: 0, to_triage: 0, saved: 0, applied: 0, deleted: 0, interviewing: 0, rejected: 0 });
    assert.deepEqual(d31, { date: "2026-10-31", new_jobs: 2, auto_deleted: 1, to_triage: 1, saved: 1, applied: 1, deleted: 1, interviewing: 0, rejected: 0 });
    assert.equal(d01.interviewing, 1);
    assert.equal(d02.rejected, 1);
    assert.equal(report.totals.new_jobs, 2);
    assert.equal(report.totals.to_triage, 1);
    assert.equal(report.totals.date, "Total");
  });

  test("single-day range and validation", () => {
    assert.equal(dailyReport([], { from: "2026-11-01", to: "2026-11-01" }, TZ).days.length, 1);
    assert.throws(() => dailyReport([], { from: "2026-11-02", to: "2026-11-01" }, TZ), RangeError);
    assert.throws(() => dailyReport([], { from: "x", to: "2026-11-01" }, TZ), RangeError);
  });

  test("default range is the last 14 local days, inclusive of today", () => {
    // 2026-11-01T06:00Z is still Oct 31 in Los Angeles.
    const r = defaultRange(new Date("2026-11-01T06:00:00Z"), TZ);
    assert.deepEqual(r, { from: "2026-10-18", to: "2026-10-31" });
    assert.equal(eachDay(r.from, r.to).length, 14);
  });
});
