import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  indexAfterRemoval,
  sortInbox,
} from "./jobFilters.js";
import { csvOrDash, formatFitLabel, formatOverallMatch, formatRelative, toLocalInput, fromLocalInput, toSecondPerson } from "./jobView.js";

const job = (over = {}) => ({
  source_id: "1",
  name: "Engineer",
  compensation: "$120k – $150k",
  remote: "true",
  fit_overall_match: "0.8",
  fit_score: "8",
  fit_have_skills: "TypeScript, React",
  fit_familiar_skills: "",
  skills: "TypeScript, React",
  captured_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("inbox order", () => {
  test("best fit first, then newest", () => {
    const sorted = sortInbox([
      job({ source_id: "a", fit_score: "6", captured_at: "2026-10-03T00:00:00Z" }),
      job({ source_id: "b", fit_score: "9", captured_at: "2026-10-01T00:00:00Z" }),
      job({ source_id: "c", fit_score: "9", fit_overall_match: "0.9", captured_at: "2026-10-01T00:00:00Z" }),
      job({ source_id: "d", fit_score: "", fit_overall_match: "", captured_at: "2026-10-09T00:00:00Z" }),
      job({ source_id: "e", fit_score: "6", captured_at: "2026-10-05T00:00:00Z" }),
    ]);
    assert.deepEqual(sorted.map((j) => j.source_id), ["c", "b", "e", "a", "d"]);
  });

  test("index stays in place after an action, clamps at the end", () => {
    assert.equal(indexAfterRemoval(2, 5), 2);
    assert.equal(indexAfterRemoval(4, 4), 3);
    assert.equal(indexAfterRemoval(0, 0), 0);
  });
});

describe("view helpers", () => {
  test("fit labels", () => {
    assert.equal(formatOverallMatch("0.91"), "91%");
    assert.equal(formatOverallMatch(""), "—");
    assert.equal(formatFitLabel("SKIP", "0"), "Skip 0/10");
    assert.equal(formatFitLabel("STRONG_PASS", "9"), "Strong pass 9/10");
    assert.equal(formatFitLabel("", ""), null);
    assert.equal(csvOrDash(" a, ,b "), "a, b");
    assert.equal(csvOrDash(""), "—");
    assert.equal(toSecondPerson("Greg should apply. Greg's stack fits."), "you should apply. your stack fits.");
  });

  test("relative time", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    assert.equal(formatRelative("2026-10-31T10:00:00Z", now), "2 hours ago");
    assert.equal(formatRelative("2026-10-31T11:59:50Z", now), "just now");
    assert.equal(formatRelative("2026-10-29T12:00:00Z", now), "2 days ago");
  });

  test("datetime-local round trip is minute precise", () => {
    const iso = "2026-10-31T20:04:00.000Z";
    assert.equal(fromLocalInput(toLocalInput(iso)), iso);
  });
});
