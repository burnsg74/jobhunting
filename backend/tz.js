// Local-time helpers. Stored times are UTC ISO; days and event ids use the system time zone.
export const DEFAULT_TZ = process.env.APP_TIMEZONE || "America/Los_Angeles";

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`. */
export function localParts(iso, tz = DEFAULT_TZ) {
  const parts = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(iso))) {
    if (type !== "literal") parts[type] = value;
  }
  return parts;
}

/** `YYYY-MM-DD` of an instant in `tz`. */
export function localDate(iso, tz = DEFAULT_TZ) {
  const p = localParts(iso, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `YYYYMMDD-HHMMSS` wall-clock stamp, used as the sortable part of event ids. */
export function localStamp(iso, tz = DEFAULT_TZ) {
  const p = localParts(iso, tz);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isDateString = (value) => typeof value === "string" && DATE_RE.test(value);

/** Add `n` calendar days to a `YYYY-MM-DD` string (pure calendar math, immune to DST). */
export function addDays(date, n) {
  const [, y, m, d] = DATE_RE.exec(date);
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + n));
  return t.toISOString().slice(0, 10);
}

/** Inclusive list of `YYYY-MM-DD` days from `from` to `to`. */
export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
