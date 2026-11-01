// Per-day counts from events.csv alone. Days are local (system time zone); stored times stay UTC.
import { DEFAULT_TZ, addDays, eachDay, isDateString, localDate } from "./tz.js";
import { isAutoSummary } from "./schema.js";

export const REPORT_FIELDS = [
  "new_jobs",
  "auto_deleted",
  "to_triage",
  "saved",
  "applied",
  "deleted",
  "interviewing",
  "rejected",
];

const blankDay = (date) => ({
  date,
  new_jobs: 0,
  auto_deleted: 0,
  to_triage: 0,
  saved: 0,
  applied: 0,
  deleted: 0,
  interviewing: 0,
  rejected: 0,
});

/** Default range: the last 14 local days ending today. */
export function defaultRange(now = new Date(), tz = DEFAULT_TZ, days = 14) {
  const to = localDate(now.toISOString(), tz);
  return { from: addDays(to, -(days - 1)), to };
}

export function dailyReport(events, { from, to }, tz = DEFAULT_TZ) {
  if (!isDateString(from) || !isDateString(to)) throw new RangeError("from and to must be YYYY-MM-DD");
  if (from > to) throw new RangeError("from must not be after to");

  const days = new Map(eachDay(from, to).map((date) => [date, blankDay(date)]));

  for (const event of events) {
    const day = days.get(localDate(event.at, tz));
    if (!day) continue;
    switch (event.type) {
      case "captured":
        day.new_jobs++;
        break;
      case "saved":
        day.saved++;
        break;
      case "applied":
        day.applied++;
        break;
      case "interviewing":
        day.interviewing++;
        break;
      case "rejected":
        day.rejected++;
        break;
      case "deleted":
        if (isAutoSummary(event.summary)) day.auto_deleted++;
        else day.deleted++;
        break;
      default:
    }
  }

  const rows = [...days.values()];
  for (const row of rows) row.to_triage = row.new_jobs - row.auto_deleted;

  const totals = blankDay("Total");
  for (const row of rows) for (const field of REPORT_FIELDS) totals[field] += row[field];

  return { from, to, days: rows, totals };
}
