// Autopilot Pre-Underwriting — the readiness score, and what it is careful not to mean.
//
// "Loan Readiness Score" is the number on the panel, and the most dangerous thing in the
// product. A number between 0 and 100 next to a borrower's name will be read as a probability
// of approval by somebody, eventually, however it is labelled. So its definition is narrow and
// it is stated on the screen every time it is shown:
//
//     READINESS MEASURES THE FILE, NOT THE BORROWER.
//     It is: how much of what this loan needs is present, readable, and free of open questions.
//     A file at 100 can still be denied. A file at 40 can close.
//
// That is defensible because it is arithmetic over documents and findings — nothing here
// estimates approval odds, and nothing here could, because this system never sees the AUS
// findings, the appraisal, the overlays, or the underwriter.
//
// The number is internal (docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md). A borrower sees the
// document requests it is computed from, never the score.

import { documentReadiness, missingForFile } from './completeness.js'

// Three parts, weighted by how much each actually blocks a file from moving.
// Documents dominate because a missing document stops everything, every time.
const WEIGHTS = Object.freeze({ documents: 0.6, questions: 0.25, confidence: 0.15 })

// What an unresolved finding costs, by severity. A high-severity finding is not three times a
// low one — it is the thing the file is waiting on.
const SEVERITY_COST = Object.freeze({ high: 25, medium: 10, low: 3 })

/**
 * @param {object} input
 * @param {Array} input.checklist        what this loan needs
 * @param {object} input.byType          classified parts keyed by docKey
 * @param {Array} input.findings         live findings (superseded ones excluded by the caller)
 * @param {Array} [input.extractions]    for the confidence component
 * @param {number} [input.asOf]
 */
export function loanReadiness(input = {}) {
  const { checklist = [], byType = {}, findings = [], extractions = [], asOf } = input
  const opts = asOf ? { asOf } : {}

  const docs = documentReadiness(checklist, byType, opts)

  // Open questions. Only what is still pending: a finding a human confirmed or dismissed has
  // been dealt with, and continuing to charge for it would mean the score never recovers from
  // work that was done.
  const open = findings.filter((f) => f && f.status === 'pending_review')
  const questionCost = open.reduce((n, f) => n + (SEVERITY_COST[f.severity] ?? 5), 0)
  const questions = clamp(100 - questionCost)

  // How well we actually read what we have. A file of perfect documents nobody could read is
  // not a ready file, and this is the component that says so.
  const confidences = extractions.map((e) => e?.confidence).filter((c) => typeof c === 'number')
  const confidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100)
    : (docs.complete > 0 ? 100 : 0)

  const percent = Math.round(
    docs.percent * WEIGHTS.documents
    + questions * WEIGHTS.questions
    + confidence * WEIGHTS.confidence,
  )

  return {
    percent: clamp(percent),
    components: {
      documents: { percent: docs.percent, complete: docs.complete, total: docs.total, weight: WEIGHTS.documents },
      questions: { percent: questions, open: open.length, weight: WEIGHTS.questions },
      confidence: { percent: confidence, readings: confidences.length, weight: WEIGHTS.confidence },
    },
    blockers: blockers({ checklist, byType, findings: open, opts }),
    meaning: 'How much of what this loan needs is present, readable, and free of open questions.',
    notMeaning: [
      'an approval or a pre-approval',
      'a probability of approval',
      'a credit decision',
      'an underwriting opinion',
    ],
  }
}

/**
 * What is actually holding the file, in the order a processor would work it.
 *
 * Documents first — a missing document blocks everything downstream and is usually one message
 * to fix. Then the findings, worst first.
 */
function blockers({ checklist, byType, findings, opts }) {
  const out = []
  for (const m of missingForFile(checklist, byType, opts)) {
    out.push({
      kind: 'document',
      docKey: m.docKey,
      label: m.label,
      // Who has to act. A processor chasing a borrower for a credit report is a wasted day.
      owner: m.providedBy,
      detail: m.gaps[0]?.message || null,
    })
  }
  const order = { high: 0, medium: 1, low: 2 }
  for (const f of [...findings].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))) {
    out.push({
      kind: 'finding',
      rule: f.rule,
      severity: f.severity,
      label: f.explanation,
      owner: 'loan_team',
      needsHumanReview: Boolean(f.needsHumanReview),
    })
  }
  return out
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * The borrower's half of the same picture: what they can actually send, phrased as requests.
 *
 * Separate function, not a flag, because the two audiences are not the same data filtered — one
 * is a set of requests and the other is a set of conclusions, and the boundary doc turns on
 * exactly that difference.
 */
export function borrowerRequests(checklist, byType, opts = {}) {
  return missingForFile(checklist, byType, { ...opts, providedBy: 'borrower' })
    .map((m) => ({ docKey: m.docKey, label: m.label, asks: m.gaps.map((g) => g.message) }))
}
