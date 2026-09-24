// What this loan file still needs — one canonical answer, for everybody.
//
// THE PROBLEM THIS SOLVES. Before this module the borrower's screen and the processor's panel
// each computed "what's left" from their own half of the world: the checklist knew about
// documents, the 1003 engine knew about answers, and nobody reconciled them. That is how a file
// ends up telling the borrower "all done" while the panel says two things are missing — and a
// borrower who is told they are finished stops, which costs a day per contradiction.
//
// So: ONE list. The borrower's view and the loan team's view are two PROJECTIONS of the same
// array, never two computations. If they ever disagree it is a rendering bug, not a data
// question, and `borrowerView`/`teamView` below are the only two projections that exist.
//
// ── What counts as a task ───────────────────────────────────────────────────
// Something a named party must DO before the file can move. Four kinds:
//
//   application_answer   a required 1003 field nobody has answered
//   application_conflict two different answers to the same question
//   document             a required document that is missing, incomplete, or unreadable
//   credit_authorization the borrower has not permitted a credit pull
//   human_review         a finding a licensed person has to look at (never the borrower's)
//
// ── What is NOT a task ──────────────────────────────────────────────────────
// Anything that is a conclusion about the applicant. Findings appear here only as work for the
// loan team, phrased as work, and `borrowerView` cannot emit them — see the audience rule in
// docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md. This module is about who must act next, not about
// whether anyone qualifies for anything.

import { missingForFile } from './completeness.js'
import { getField, SECTION_LABELS } from '../conversational-1003/applicationCatalog.js'

// The repo's one-line localizer, same shape as review.js and questionPlanner.js use. A catalog
// label is {en, es, ru}; a missing locale falls back to English rather than rendering nothing.
const pick = (v, locale = 'en') => (!v ? '' : typeof v === 'string' ? v : v[locale] || v.en || '')

/**
 * The operational sections a file is reported in. Deliberately fewer than the 1003's own
 * catalog sections: a borrower and a processor both think in these terms, and "supplemental"
 * or "demographics" as a headline tells neither of them anything useful.
 */
export const OPERATIONAL_SECTIONS = Object.freeze([
  'identity', 'income', 'assets', 'liabilities', 'property', 'declarations', 'documents',
])

export const SECTION_TITLES = Object.freeze({
  identity: 'Identity',
  income: 'Income',
  assets: 'Assets',
  liabilities: 'Debts',
  property: 'Property',
  declarations: 'Application questions',
  documents: 'Documents',
})

// 1003 catalog section → operational section. Employment questions are income questions to
// everyone except a form designer; residence belongs with identity for the same reason.
const SECTION_MAP = Object.freeze({
  identity: 'identity',
  residence: 'identity',
  employment: 'income',
  income: 'income',
  assets: 'assets',
  liabilities: 'liabilities',
  loan: 'property',
  reo: 'property',
  declarations: 'declarations',
  demographics: 'declarations',
  supplemental: 'declarations',
})

const operationalSection = (catalogSection) => SECTION_MAP[catalogSection] || 'declarations'

// Which document belongs to which section, for the rollup and for the organized package.
export const DOCUMENT_SECTION = Object.freeze({
  id_photo: 'identity',
  paystubs_30d: 'income',
  w2_2yr: 'income',
  tax_return_full: 'income',
  business_lic: 'income',
  bank_2mo: 'assets',
  bank_12mo: 'assets',
  reserves: 'assets',
  credit_report: 'liabilities',
  mortgage_statement: 'property',
  hoi_dec: 'property',
  tax_bill: 'property',
  purchase_contract: 'property',
  lease_rentroll: 'property',
  coe: 'identity',
  dd214: 'identity',
})

/**
 * Build the file's task list.
 *
 * Pure. Every input is already computed by a layer that owns it — the 1003 engine owns answers,
 * completeness owns documents, the rule engine owns findings — and this only arranges them.
 *
 * @param {object} input
 * @param {object} [input.report]        computeCompleteness() output for the 1003
 * @param {Array}  [input.checklist]     what this loan needs, as {docKey}
 * @param {object} [input.byType]        classified document parts keyed by docKey
 * @param {Array}  [input.findings]      live pre-underwriting findings
 * @param {object} [input.credit]        { authorized: boolean, reason: string|null }
 * @param {Array}  [input.unread]        documents uploaded but not yet read
 * @param {number} [input.asOf]
 * @returns {{tasks: Array, sections: Array, operational: object}}
 */
export function buildFileTasks(input = {}) {
  const {
    report = null, checklist = [], byType = {}, findings = [], credit = null,
    unread = [], asOf, locale = 'en',
  } = input
  const opts = asOf ? { asOf } : {}
  const tasks = []

  // ── Application answers ──────────────────────────────────────────────────
  // The borrower's own words are the only source for these, so the borrower owns them. The
  // title comes from the catalog's borrower-facing label — the dotted path is a developer's
  // name for the field and must never reach a borrower's screen.
  for (const open of report?.openFields || []) {
    tasks.push({
      id: `answer:${open.path}`,
      kind: 'application_answer',
      section: operationalSection(open.section),
      owner: 'borrower',
      title: pick(getField(open.path)?.label, locale) || labelFromPath(open.path),
      detail: null,
      path: open.path,
      blocking: true,
    })
  }

  // A structural gap is "you told us you have another job but we have no details for it" —
  // still the borrower's to close, still phrased as a question rather than as a defect.
  for (const gap of report?.structural || []) {
    tasks.push({
      id: `structural:${gap.kind}:${gap.group || 'file'}:${gap.partyIndex ?? 0}`,
      kind: 'application_answer',
      section: operationalSection(gap.group),
      owner: 'borrower',
      title: structuralTitle(gap),
      detail: null,
      blocking: true,
    })
  }

  // ── Contradictions ───────────────────────────────────────────────────────
  // Two answers to one question. Only the borrower can say which is right; the engine must
  // never pick, and the task exists so that refusal is visible rather than silent.
  for (const conflict of report?.conflicts || []) {
    tasks.push({
      id: `conflict:${conflict.path}`,
      kind: 'application_conflict',
      section: operationalSection(conflict.section),
      owner: 'borrower',
      title: 'Two different answers were recorded — please confirm which is right',
      detail: null,
      path: conflict.path,
      blocking: true,
    })
  }

  // ── Documents ────────────────────────────────────────────────────────────
  // `missingForFile` already phrases every gap as something to send. That phrasing is what
  // makes these safe to show the borrower verbatim, and the reason this module does not write
  // its own document sentences.
  for (const miss of missingForFile(checklist, byType, opts)) {
    tasks.push({
      id: `document:${miss.docKey}`,
      kind: 'document',
      section: DOCUMENT_SECTION[miss.docKey] || 'documents',
      owner: miss.providedBy === 'loan_team' ? 'loan_team' : 'borrower',
      title: miss.label,
      // Each gap is its own sentence; the screen renders them as a list under the document.
      requests: miss.gaps.map((g) => g.message),
      detail: miss.gaps[0]?.message || null,
      docKey: miss.docKey,
      blocking: true,
    })
  }

  // ── Credit authorization ─────────────────────────────────────────────────
  // The borrower's act and nobody else's, so it is their task — but the wording stays about
  // permission, never about what the report might say.
  if (credit && credit.authorized === false) {
    tasks.push({
      id: 'credit_authorization',
      kind: 'credit_authorization',
      section: 'liabilities',
      owner: 'borrower',
      title: credit.reason === 'expired'
        ? 'Your permission to check credit has expired — please authorize again'
        : 'Give permission to check your credit',
      detail: null,
      blocking: true,
    })
  }

  // ── Work that is the team's alone ────────────────────────────────────────
  // Unread uploads: the file cannot be called complete on documents nobody has looked at, and
  // pretending otherwise is the failure mode the panel exists to prevent.
  if (unread.length) {
    tasks.push({
      id: 'unread_documents',
      kind: 'human_review',
      section: 'documents',
      owner: 'loan_team',
      title: `${unread.length} uploaded document${unread.length === 1 ? '' : 's'} not read yet`,
      detail: 'Nothing above accounts for these until they are read.',
      blocking: false,
    })
  }

  // Findings a person must look at. NEVER borrower-owned and never borrower-visible: a finding
  // characterizes the applicant, which is the line the boundary document draws.
  for (const f of findings) {
    if (!f || f.status !== 'pending_review') continue
    tasks.push({
      id: `finding:${f.id || f.rule}`,
      kind: 'human_review',
      section: findingSection(f.category),
      owner: 'loan_team',
      title: f.explanation,
      detail: null,
      rule: f.rule,
      severity: f.severity,
      // Human review is work, not a blocker on the borrower — the file can be operationally
      // complete with findings outstanding, which is exactly what "except for human-reviewed
      // items" means on the internal screen.
      blocking: false,
    })
  }

  return {
    tasks,
    sections: rollup(tasks, report, checklist, byType, opts),
    operational: operationalState(tasks, report, checklist),
  }
}

/**
 * A structural gap in words a borrower recognizes.
 *
 * The engine's own vocabulary — `min_records`, `history_backfill`, `history_gap` — is precise
 * and useless to the person who has to act on it. Each one becomes a sentence about what they
 * are being asked for, and an unrecognized kind falls back to something honest rather than to
 * the raw identifier.
 */
function structuralTitle(gap) {
  const what = GROUP_NOUN[gap.group] || 'details'
  switch (gap.kind) {
    case 'min_records':
      return `Tell us about your ${what}`
    case 'history_backfill':
      return `We need your ${what} going back two years — please add the earlier one`
    case 'history_gap':
      return `There is a gap in your ${what} history — please tell us about that period`
    case 'history_overlap':
      return `Two ${what} entries overlap in time — please confirm the dates`
    default:
      return `Some ${what} details are still needed`
  }
}

const GROUP_NOUN = Object.freeze({
  residence: 'address',
  employment: 'employment',
  income: 'income',
  assets: 'accounts',
  liabilities: 'debts',
  reo: 'properties you own',
})

const findingSection = (category) => ({
  income: 'income', employment: 'income', assets: 'assets', liabilities: 'liabilities',
  identity: 'identity', property: 'property', documents: 'documents',
}[category] || 'documents')

/**
 * Per-section state, for the one-glance internal summary.
 *
 * A section is `needs_attention` when somebody must act on it and `complete` when nobody must.
 * Human-review items mark a section as needing attention without making the file incomplete —
 * the two questions are different and the screen asks both.
 */
function rollup(tasks, report, checklist, byType, opts) {
  const out = []
  for (const key of OPERATIONAL_SECTIONS) {
    const mine = tasks.filter((t) => t.section === key)
    const blocking = mine.filter((t) => t.blocking)
    const review = mine.filter((t) => t.kind === 'human_review')
    const applicable = isApplicable(key, report, checklist)
    out.push({
      key,
      title: SECTION_TITLES[key],
      open: blocking.length,
      review: review.length,
      borrowerOpen: blocking.filter((t) => t.owner === 'borrower').length,
      teamOpen: blocking.filter((t) => t.owner === 'loan_team').length,
      state: !applicable ? 'not_applicable'
        : blocking.length > 0 ? 'needs_attention'
          : review.length > 0 ? 'in_review'
            : 'complete',
    })
  }
  return out
}

// A section nobody is required to fill is "not applicable", not "complete" — the difference
// matters to a processor deciding whether to chase something.
function isApplicable(key, report, checklist) {
  if (key === 'documents') return true
  if (key === 'liabilities') return true
  const bySection = report?.bySection || null
  const hasDoc = (checklist || []).some((c) => (DOCUMENT_SECTION[c.docKey || c.doc_key] || 'documents') === key)
  if (hasDoc) return true
  if (!bySection) return false
  return Object.entries(bySection).some(([cat, b]) => operationalSection(cat) === key && b.required > 0)
}

/**
 * Operational completeness — the ONE number.
 *
 * Narrowly defined and stated wherever it is shown: the share of required items that are
 * present and free of open questions. It is arithmetic over a checklist, nothing more. It is
 * not a probability of approval, it cannot become one, and the strings below travel with it so
 * no screen can render the number without its meaning.
 *
 * Human-review items are deliberately excluded from the denominator: a processor's reading of
 * a flagged deposit is not something the FILE is missing, and counting it would mean a file can
 * never be operationally complete while a person still has an opinion to form.
 */
function operationalState(tasks, report, checklist) {
  const blocking = tasks.filter((t) => t.blocking)
  const appRequired = (report?.totalRequired ?? 0)
  const docRequired = (checklist || []).length
  const total = appRequired + docRequired + 1 // +1: credit authorization
  const outstanding = blocking.length
  const done = Math.max(0, total - outstanding)

  return {
    percent: total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100)),
    outstanding,
    total,
    borrowerOutstanding: blocking.filter((t) => t.owner === 'borrower').length,
    teamOutstanding: blocking.filter((t) => t.owner === 'loan_team').length,
    humanReview: tasks.filter((t) => t.kind === 'human_review').length,
    // True only when nobody has anything left to do except form an opinion.
    complete: outstanding === 0,
    meaning: 'The share of required information and documents that is present and free of open questions.',
    notMeaning: Object.freeze([
      'an approval or a pre-approval',
      'a probability of approval',
      'a credit decision',
      'an underwriting opinion',
    ]),
  }
}

/**
 * The borrower's projection.
 *
 * Structurally incapable of leaking: it filters to tasks the borrower owns, and `human_review`
 * is never borrower-owned, so a finding cannot reach this output even by mistake. It also drops
 * every internal field (rule, severity, path) rather than trusting a screen not to render them.
 */
export function borrowerView(tasks) {
  return (tasks || [])
    .filter((t) => t.owner === 'borrower' && t.kind !== 'human_review')
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      section: t.section,
      sectionTitle: SECTION_TITLES[t.section] || 'Your application',
      title: t.title,
      requests: t.requests || (t.detail ? [t.detail] : []),
      docKey: t.docKey || null,
    }))
}

/** The team's projection: everything, in the order a processor would work it. */
export function teamView(tasks) {
  const rank = { document: 0, application_conflict: 1, application_answer: 2, credit_authorization: 3, human_review: 4 }
  return [...(tasks || [])].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9))
}

/**
 * The single next thing the borrower should do.
 *
 * Documents first: they are usually one tap from a phone and they unblock the analysis that
 * produces everything else. Then contradictions, which are quick and cheap to resolve. Then
 * the interview, which is the long tail.
 */
export function nextBorrowerAction(tasks) {
  const mine = borrowerView(tasks)
  const order = ['document', 'credit_authorization', 'application_conflict', 'application_answer']
  for (const kind of order) {
    const hit = mine.find((t) => t.kind === kind)
    if (hit) return hit
  }
  return null
}

const labelFromPath = (path) => String(path).split('.').pop().replace(/\[\d+\]/g, '')
  .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())

export { SECTION_LABELS }
