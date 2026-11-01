// Inbox ordering helpers.

/** Best fit first (score, then overall match), then newest capture. */
export function sortInbox(jobs) {
  const num = (v) => {
    const n = Number(String(v ?? "").trim());
    return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : -1;
  };
  return [...jobs].sort(
    (a, b) =>
      num(b.fit_score) - num(a.fit_score) ||
      num(b.fit_overall_match) - num(a.fit_overall_match) ||
      (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : 0),
  );
}

/** Next index after removing the current job from a queue of `length` items (stays in place, clamps at the end). */
export function indexAfterRemoval(index, newLength) {
  if (newLength <= 0) return 0;
  return Math.min(index, newLength - 1);
}
