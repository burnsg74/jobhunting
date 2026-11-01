// Display helpers for job cards. Ported from the old app's lib/job-view.ts.

const FIT_LABELS = { STRONG_PASS: "Strong pass", PASS: "Pass", HOLD: "Hold", SKIP: "Skip" };

export const STATUS_LABELS = {
  new: "New",
  saved: "Saved",
  applied: "Applied",
  deleted: "Deleted",
  interviewing: "Interviewing",
  rejected: "Rejected",
};

export const STATUSES = ["new", "saved", "applied", "interviewing", "rejected", "deleted"];

export const EVENT_TYPE_LABELS = {
  captured: "Captured",
  restored: "Restored",
  saved: "Saved",
  applied: "Applied",
  deleted: "Deleted",
  interviewing: "Interviewing",
  rejected: "Rejected",
  offer: "Offer",
  withdrew: "Withdrew",
  note: "Note",
  pull: "Pull",
};

/** Types you can write by hand in the Log. */
export const MANUAL_TYPES = ["note", "applied", "interviewing", "rejected", "offer", "withdrew", "saved", "deleted", "restored"];
export const NOTE_TYPES = ["note", "offer", "withdrew"];

export function formatOverallMatch(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const percent = n >= 0 && n <= 1 ? n * 100 : n;
  return `${Math.round(percent)}%`;
}

export function formatFitLabel(recommendation, score) {
  const rec = String(recommendation ?? "").trim();
  const sc = String(score ?? "").trim();
  if (!rec && !sc) return null;
  const label = rec ? (FIT_LABELS[rec] ?? rec.replaceAll("_", " ")) : "";
  if (label && sc) return `${label} ${sc}/10`;
  if (label) return label;
  return `${sc}/10`;
}

/** The fit summary was written about "Greg"; show it as "you". */
export function toSecondPerson(text) {
  return String(text ?? "")
    .replace(/\bfor Greg\b/gi, "")
    .replace(/\bGreg's\b/g, "your")
    .replace(/\bGreg should\b/g, "you should")
    .replace(/\bGreg can\b/g, "you can")
    .replace(/\bGreg\b/g, "you")
    .replace(/\bhis 25\+/g, "your 25+")
    .replace(/\bhis modern\b/g, "your modern")
    .replace(/\bhis preference\b/g, "your preference")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/—+/g, "—")
    .trim();
}

export function csvOrDash(value) {
  const items = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items.join(", ") : "—";
}

export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const UNITS = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 hours ago" / "in 3 days". */
export function formatRelative(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = Math.round((then - now) / 1000);
  if (Math.abs(delta) < 45) return "just now";
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(delta) >= seconds || unit === "minute") return RELATIVE.format(Math.round(delta / seconds), unit);
  }
  return "";
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY_HEADING = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export const formatDate = (iso) => (Number.isNaN(Date.parse(iso)) ? "" : DATE.format(Date.parse(iso)));
export const formatTime = (iso) => (Number.isNaN(Date.parse(iso)) ? "" : TIME.format(Date.parse(iso)));

/** "Posted Aug 30, 2026 (2 months ago)". */
export function formatPostedAt(iso, now = Date.now()) {
  if (Number.isNaN(Date.parse(iso))) return "";
  return `${formatDate(iso)} (${formatRelative(iso, now)})`;
}

/** Local `YYYY-MM-DD` (browser time zone) of an ISO instant. */
export function localDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayHeading(day) {
  const [y, m, d] = day.split("-").map(Number);
  return DAY_HEADING.format(new Date(y, m - 1, d));
}

/** `<input type=datetime-local>` value (local, minute precision) from an ISO instant. */
export function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = (value) => new Date(value).toISOString();
