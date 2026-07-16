// Phase 1B — pure loan-team dashboard derivations (§8). Deterministic, testable. Computes
// "what changed today" and blocker counts from the review-queue file rows the LO dashboard
// already loads. `now`/`since` are passed in so this stays pure (no clock read here).

// Files whose lastActivity falls within [now - windowMs, now]. Deterministic given inputs.
export function filesChangedSince(files = [], nowMs, windowMs = 24 * 60 * 60 * 1000) {
  const since = nowMs - windowMs
  return files.filter((f) => {
    const t = f.lastActivity ? Date.parse(f.lastActivity) : NaN
    return Number.isFinite(t) && t >= since && t <= nowMs
  })
}

// Deterministic blocker rollup across the file set.
export function blockerSummary(files = []) {
  let missingDocs = 0, pendingReview = 0, openConditions = 0, stuck = 0, blockingFiles = 0
  for (const f of files) {
    const m = f.missingDocs || 0
    const p = f.pendingReview || 0
    const c = f.openConditions || 0
    missingDocs += m; pendingReview += p; openConditions += c
    if (f.stuck) stuck++
    if (m > 0 || p > 0 || c > 0 || f.stuck) blockingFiles++
  }
  return { missingDocs, pendingReview, openConditions, stuck, blockingFiles, totalFiles: files.length }
}

// Files needing borrower action (missing docs or open conditions) — deterministic filter.
export function filesNeedingBorrowerAction(files = []) {
  return files.filter((f) => (f.missingDocs || 0) > 0 || (f.openConditions || 0) > 0)
}
