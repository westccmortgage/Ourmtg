// Autopilot Pre-Underwriting — a finding is a record, not a sentence.
//
// The whole point of storing findings structurally is that "why did this appear?" has an answer
// made of facts: which rule fired, which fields it read, out of which documents, and how sure
// the extraction of each one was. Prose cannot be audited, re-checked when a document is
// replaced, or counted when a program's rules change. A record can.
//
// ── On confidence ───────────────────────────────────────────────────────────
// A finding does NOT carry a confidence of its own, and that is deliberate. Rules are
// deterministic: given these numbers, income_consistency either fires or it does not. All of the
// uncertainty lives upstream, in whether the numbers were read correctly. Collapsing both into
// one score produces a number that means "the model is unsure this is a bank statement" in one
// row and "the rule is fairly sure" in the next, and nobody can tell which — exactly the opacity
// structured findings exist to remove.
//
// So each piece of evidence carries its own extraction confidence, and the finding exposes the
// weakest one. That is the number a reviewer actually needs: the strength of the shakiest thing
// the conclusion rests on.
//
// ── On audience ─────────────────────────────────────────────────────────────
// Every finding is internal (docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md). A finding characterizes
// the applicant or their loan, which is the line borrower-facing output does not cross. What
// reaches a borrower is a document request, produced by completeness.js, or a reviewed summary a
// human chose to release.

export const CATEGORIES = Object.freeze([
  'income', 'employment', 'assets', 'liabilities', 'identity', 'property', 'documents',
])

export const SEVERITIES = Object.freeze(['low', 'medium', 'high'])

export const STATUSES = Object.freeze([
  'pending_review',  // the agent produced it; nobody has looked
  'confirmed',       // a reviewer agrees it is real
  'corrected',       // a reviewer fixed the underlying data; see resolution
  'dismissed',       // a reviewer judged it not an issue; see resolution
])

// Below this, an extracted value is not trustworthy enough to reason from on its own. It does
// not make a finding wrong — it makes it a question for a person rather than a statement.
export const REVIEW_CONFIDENCE_THRESHOLD = 0.9

/**
 * One thing a rule looked at.
 *
 * @typedef {object} Evidence
 * @property {string} docKey      which document it came from ('application' for the 1003)
 * @property {string} field       which field
 * @property {*} value            what was read
 * @property {number|null} confidence  extraction confidence, 0–1; null when the value is not
 *                                     model-extracted (a borrower's own typed answer, a
 *                                     deterministic calculation)
 * @property {string} [documentId]     the specific upload, so a reviewer can open it
 */

/** @returns {Evidence} */
export function evidence(docKey, field, value, confidence = null, documentId = undefined) {
  return {
    docKey: String(docKey),
    field: String(field),
    value,
    confidence: normalizeConfidence(confidence),
    ...(documentId ? { documentId } : {}),
  }
}

/**
 * Build a finding. Pure — no ids from randomness, no timestamps; the caller supplies both so
 * the same inputs always produce the same record and the rule engine stays replayable.
 *
 * @param {object} spec
 * @param {string} spec.rule          stable identifier, e.g. 'income_consistency'
 * @param {string} spec.category      one of CATEGORIES
 * @param {string} spec.severity      one of SEVERITIES
 * @param {string} spec.explanation   why it fired, in a reviewer's terms — see below
 * @param {Evidence[]} spec.evidence
 * @param {string} [spec.id]
 */
export function finding({ rule, category, severity, explanation, evidence: ev = [], id }) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown finding category: ${category}`)
  if (!SEVERITIES.includes(severity)) throw new Error(`unknown finding severity: ${severity}`)

  const items = ev.filter(Boolean)
  const confidences = items.map((e) => e.confidence).filter((c) => c !== null)
  const minConfidence = confidences.length ? Math.min(...confidences) : null

  return Object.freeze({
    id: id || null,
    rule,
    category,
    severity,
    explanation,
    evidence: Object.freeze(items),
    sourceDocuments: Object.freeze([...new Set(items.map((e) => e.docKey))]),
    // The weakest link, not an average: a conclusion is only as good as the shakiest number
    // under it, and averaging would let three confident reads paper over one bad one.
    minConfidence,
    // Either the rule is one that always wants a person, or something it read is too uncertain
    // to act on alone.
    needsHumanReview: minConfidence !== null && minConfidence < REVIEW_CONFIDENCE_THRESHOLD,
    status: 'pending_review',
    audience: 'team',
  })
}

/**
 * Record what a human decided. Returns a new finding — the original is never mutated, so the
 * history of what the agent said before a person touched it stays intact.
 *
 * A correction is the most valuable output this system produces: it is the case where the rules
 * or the extraction were wrong, described by someone who knew better.
 */
export function resolve(f, { status, by, at, note, correctedFields }) {
  if (!STATUSES.includes(status)) throw new Error(`unknown finding status: ${status}`)
  if (status === 'pending_review') throw new Error('resolve() records a decision; it cannot un-review')
  return Object.freeze({
    ...f,
    status,
    resolution: Object.freeze({
      by: by || null,
      at: at || null,
      note: note || null,
      correctedFields: Object.freeze(correctedFields || []),
    }),
  })
}

/** Ordering for the reviewer's queue: what wants a person first, then by severity. */
export function triage(findings) {
  const sev = { high: 0, medium: 1, low: 2 }
  return [...(findings || [])].filter(Boolean).sort((a, b) => {
    if (a.needsHumanReview !== b.needsHumanReview) return a.needsHumanReview ? -1 : 1
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
    return String(a.rule).localeCompare(String(b.rule))
  })
}

function normalizeConfidence(c) {
  if (c === null || c === undefined) return null
  const n = Number(c)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}
