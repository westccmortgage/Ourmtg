// Autopilot Pre-Underwriting — the rule engine (layer 3).
//
// Rules are pure functions from what was extracted to findings. No model runs here. The model's
// job ended upstream: it said what each document is and what it says, with a confidence per
// value. What any of that MEANS is decided by these functions, so the reasoning can be read,
// tested, replayed, and argued with.
//
// ── How these are written ───────────────────────────────────────────────────
// The explanation names the reason, not the symptom. "Income mismatch" tells a processor
// nothing they could not see; "the pay stub, W-2, and application describe three different
// periods" tells them what to do next. A rule that cannot explain itself in those terms is a
// rule that should not fire.
//
// Rules also refuse to fire on absence. Missing data is completeness.js's job, and a rule that
// treated "we could not read it" as "it disagrees" would bury real findings under noise.

import { finding, evidence, REVIEW_CONFIDENCE_THRESHOLD } from './findings.js'

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const date = (v) => {
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : null
}
const monthsBetween = (later, earlier) => (later - earlier) / (30.44 * 86_400_000)
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Relative difference between two positive numbers, 0–1. */
const spread = (a, b) => Math.abs(a - b) / Math.max(a, b)

// Fields that name the borrower. Deliberately not "anything containing 'name'": that both misses
// `accountHolder` and sweeps in `employerName`, `sellerNames`, and `carrierName` — companies,
// whose spelling differing from the borrower's is not a finding.
const PERSON_NAME_FIELDS = new Set([
  'fullName', 'employeeName', 'accountHolder', 'veteranName', 'borrowerName', 'coBorrowerName',
])

// ─────────────────────────────────────────────────────────────────────────────
// Rule: anything the model was unsure about
// ─────────────────────────────────────────────────────────────────────────────
// Not a finding about the borrower — a finding about our own reading. It exists so a low
// confidence never disappears silently into a calculation nobody re-checked.
export function lowConfidenceExtractions(ctx) {
  const out = []
  for (const e of ctx.extractions || []) {
    if (e.confidence === null || e.confidence === undefined) continue
    if (e.confidence >= REVIEW_CONFIDENCE_THRESHOLD) continue
    out.push(finding({
      id: ctx.id?.(`low_confidence:${e.docKey}:${e.field}`),
      rule: 'low_confidence_extraction',
      category: 'documents',
      severity: e.confidence < 0.7 ? 'medium' : 'low',
      explanation: `“${e.field}” was read from the ${e.docKey} with ${Math.round(e.confidence * 100)}% confidence, which is below the threshold for using it without checking. Open the document and confirm the value.`,
      evidence: [evidence(e.docKey, e.field, e.value, e.confidence, e.documentId)],
    }))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: income consistency across the pay stub, the W-2, and the application
// ─────────────────────────────────────────────────────────────────────────────
// The three numbers routinely disagree for a completely innocent reason — they describe
// different periods. A raise, a bonus year, three months on the job: all produce a "mismatch"
// that is not a discrepancy at all. Saying so is the difference between a useful finding and
// one a processor learns to ignore.
export function incomeConsistency(ctx) {
  const stated = num(ctx.application?.monthlyIncome)
  const stub = pick(ctx, 'paystubs_30d')
  const w2 = pick(ctx, 'w2_2yr')

  const stubMonthly = monthlyFromStub(stub)
  const w2Monthly = w2 ? divide(num(w2.wagesTipsOther), 12) : null

  const known = [stated, stubMonthly, w2Monthly].filter((v) => v !== null && v > 0)
  if (known.length < 2) return []          // nothing to compare is not a discrepancy

  const worst = Math.max(...known.map((a) => Math.max(...known.map((b) => spread(a, b)))))

  // Two independent triggers, and the second matters more than the first.
  //
  // Amounts can agree closely and still be uncomparable: a W-2 for last year cannot describe a
  // job that started three months ago, no matter how similar the numbers look. That is the case
  // a numeric tolerance misses entirely — and it is the one where quietly averaging the figures
  // would produce a qualifying income nobody should rely on.
  const start = date(ctx.employment?.startDate)
  const asOf = ctx.asOf ?? Date.now()
  const w2Year = Number(w2?.taxYear)
  const periodsCannotOverlap = w2Monthly !== null && start !== null && (
    // The W-2's year ended before this job began.
    (Number.isInteger(w2Year) && w2Year < new Date(start).getUTCFullYear())
    // Or the job is too new for any W-2 to cover a full year of it.
    || monthsBetween(asOf, start) < 12
  )

  if (worst < 0.1 && !periodsCannotOverlap) return []   // agreeing, and comparable

  const ev = [
    stated !== null ? evidence('application', 'monthlyIncome', stated, null) : null,
    stubMonthly !== null ? evidence('paystubs_30d', 'grossPay', stub?.grossPay, stub?._confidence, stub?.documentId) : null,
    w2Monthly !== null ? evidence('w2_2yr', 'wagesTipsOther', w2?.wagesTipsOther, w2?._confidence, w2?.documentId) : null,
  ].filter(Boolean)

  // Why they might legitimately differ, named specifically where we can tell.
  const reasons = []
  if (start !== null && monthsBetween(asOf, start) < 12) {
    reasons.push(`employment began about ${Math.max(1, Math.round(monthsBetween(asOf, start)))} months ago, so the W-2 covers a period that does not include this job in full`)
  }
  if (Number.isInteger(w2Year) && start !== null && w2Year < new Date(start).getUTCFullYear()) {
    reasons.push(`the W-2 is for ${w2Year}, a year that ended before this job started`)
  } else if (Number.isInteger(w2Year) && w2Year < new Date(asOf).getUTCFullYear() - 1) {
    reasons.push(`the W-2 is for ${w2Year}, which is not the most recent full year`)
  }
  if (stub?.payFrequency) {
    reasons.push(`the pay stub is ${String(stub.payFrequency).toLowerCase()} and was annualized to compare`)
  }

  return [finding({
    id: ctx.id?.('income_consistency'),
    rule: 'income_consistency',
    category: 'income',
    severity: worst > 0.25 ? 'high' : 'medium',
    explanation:
      `Qualifying income needs a human decision: the pay stub, the W-2, and the application describe ` +
      `different amounts (${known.map(money).join(' / ')} per month). ` +
      (reasons.length
        ? `They may describe different periods — ${reasons.join('; ')}. Decide which period qualifies before calculating.`
        : `No period difference explains it from the documents on file. Confirm which figure is the qualifying income.`),
    evidence: ev,
  })]
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: employment long enough for the income being used
// ─────────────────────────────────────────────────────────────────────────────
export function employmentTenure(ctx) {
  const start = date(ctx.employment?.startDate)
  if (start === null) return []
  const months = monthsBetween(ctx.asOf ?? Date.now(), start)
  if (months >= 24) return []
  return [finding({
    id: ctx.id?.('employment_tenure'),
    rule: 'employment_tenure',
    category: 'employment',
    severity: months < 12 ? 'high' : 'medium',
    explanation:
      `Employment started about ${Math.max(1, Math.round(months))} months ago, short of the two-year history most programs price on. ` +
      `This is not automatically disqualifying — prior employment in the same line of work often covers it — but the file needs that history documented before income can be relied on.`,
    evidence: [evidence('application', 'employmentStartDate', ctx.employment.startDate, ctx.employment.confidence ?? null)],
  })]
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: an employment gap the file does not explain
// ─────────────────────────────────────────────────────────────────────────────
export function employmentGap(ctx) {
  const jobs = (ctx.employment?.history || [])
    .map((j) => ({ ...j, s: date(j.startDate), e: date(j.endDate) }))
    .filter((j) => j.s !== null)
    .sort((a, b) => a.s - b.s)
  if (jobs.length < 2) return []

  const out = []
  for (let i = 1; i < jobs.length; i += 1) {
    const prevEnd = jobs[i - 1].e
    if (prevEnd === null) continue
    const gap = monthsBetween(jobs[i].s, prevEnd)
    if (gap < 1.5) continue
    out.push(finding({
      id: ctx.id?.(`employment_gap:${i}`),
      rule: 'employment_gap',
      category: 'employment',
      severity: gap >= 6 ? 'medium' : 'low',
      explanation:
        `About ${Math.round(gap)} months between leaving ${jobs[i - 1].employerName || 'the previous employer'} and starting ${jobs[i].employerName || 'the current one'}. ` +
        `A written explanation from the borrower is the normal way to clear this.`,
      evidence: [
        evidence('application', 'employmentHistory.endDate', jobs[i - 1].endDate, null),
        evidence('application', 'employmentHistory.startDate', jobs[i].startDate, null),
      ],
    }))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: a deposit large enough that its source has to be documented
// ─────────────────────────────────────────────────────────────────────────────
// The threshold is relative to income, not a fixed dollar figure: $18,500 means something very
// different on $8,000 a month than on $80,000.
export function largeDeposits(ctx) {
  const monthly = num(ctx.application?.monthlyIncome) || monthlyFromStub(pick(ctx, 'paystubs_30d'))
  if (!monthly || monthly <= 0) return []
  const threshold = monthly * 0.5

  return (ctx.deposits || [])
    .map((d) => ({ ...d, amount: num(d.amount) }))
    .filter((d) => d.amount !== null && d.amount >= threshold)
    .map((d, i) => finding({
      id: ctx.id?.(`large_deposit:${d.date || i}:${d.amount}`),
      rule: 'large_deposit',
      category: 'assets',
      severity: d.amount >= monthly * 2 ? 'high' : 'medium',
      explanation:
        `A deposit of ${money(d.amount)}${d.date ? ` on ${d.date}` : ''} is more than half a month of income, so its source has to be documented before it counts toward funds to close. ` +
        `Payroll and transfers between the borrower's own accounts usually clear immediately once identified.`,
      evidence: [evidence(d.docKey || 'bank_2mo', 'deposit', d.amount, d.confidence ?? null, d.documentId)],
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: the same person, spelled the same way
// ─────────────────────────────────────────────────────────────────────────────
export function nameConsistency(ctx) {
  // An explicit list, not a search for "name": the bank statement's person field is
  // `accountHolder`, which a name-shaped regex misses entirely — and missing it is what makes
  // this rule silently useless on the document most likely to carry a different name.
  const names = (ctx.extractions || [])
    .filter((e) => PERSON_NAME_FIELDS.has(e.field))
    .filter((e) => norm(e.value).length > 2)
  const groups = new Map()
  for (const n of names) {
    const k = norm(n.value)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(n)
  }
  if (groups.size < 2) return []

  // A middle initial appearing on one document is not a discrepancy worth a processor's time.
  const keys = [...groups.keys()]
  if (keys.every((k) => sharesSurnameAndInitial(k, keys[0]))) return []

  return [finding({
    id: ctx.id?.('name_consistency'),
    rule: 'name_consistency',
    category: 'identity',
    severity: 'low',
    explanation:
      `The borrower's name appears in more than one form across the file (${keys.join(' / ')}). ` +
      `Usually a maiden name, a suffix, or a typo — but the closing documents have to match, so confirm which is legal.`,
    evidence: names.map((n) => evidence(n.docKey, n.field, n.value, n.confidence, n.documentId)),
  })]
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: everyone is talking about the same property
// ─────────────────────────────────────────────────────────────────────────────
export function propertyConsistency(ctx) {
  const addrs = (ctx.extractions || [])
    .filter((e) => /propertyAddress/i.test(e.field))
    .filter((e) => norm(e.value).length > 5)
  const groups = new Map()
  for (const a of addrs) {
    const k = streetKey(a.value)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(a)
  }
  if (groups.size < 2) return []

  return [finding({
    id: ctx.id?.('property_consistency'),
    rule: 'property_consistency',
    category: 'property',
    severity: 'high',
    explanation:
      `Documents in this file name different properties (${[...groups.keys()].join(' / ')}). ` +
      `Either a document belongs to another file, or the borrower owns more than one property and the wrong one was sent. Resolve this before anything is calculated from it.`,
    evidence: addrs.map((a) => evidence(a.docKey, a.field, a.value, a.confidence, a.documentId)),
  })]
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: an obligation on the credit report that the application does not mention
// ─────────────────────────────────────────────────────────────────────────────
export function undisclosedLiabilities(ctx) {
  const declared = new Set((ctx.application?.liabilities || []).map((l) => norm(l.creditorName)))
  return (ctx.creditLiabilities || [])
    .filter((l) => num(l.monthlyPayment) > 0)
    .filter((l) => !declared.has(norm(l.creditorName)))
    .map((l) => finding({
      id: ctx.id?.(`undisclosed_liability:${norm(l.creditorName)}`),
      rule: 'undisclosed_liability',
      category: 'liabilities',
      severity: num(l.monthlyPayment) >= 300 ? 'high' : 'medium',
      explanation:
        `${l.creditorName} shows a payment of ${money(num(l.monthlyPayment))} on the credit report but does not appear on the application. ` +
        `It has to be counted in the ratios, or documented as paid off or as someone else's obligation.`,
      evidence: [
        evidence('credit_report', 'monthlyPayment', l.monthlyPayment, l.confidence ?? null, l.documentId),
        evidence('application', 'liabilities', null, null),
      ],
    }))
}

export const RULES = Object.freeze([
  lowConfidenceExtractions,
  incomeConsistency,
  employmentTenure,
  employmentGap,
  largeDeposits,
  nameConsistency,
  propertyConsistency,
  undisclosedLiabilities,
])

/**
 * Run every rule. A rule that throws is contained: one bad rule must not take the whole
 * analysis down, and a processor is better served by seven findings and a logged error than by
 * an empty panel.
 *
 * @returns {{findings: Array, errors: Array<{rule: string, message: string}>}}
 */
export function runRules(ctx, rules = RULES) {
  const findings = []
  const errors = []
  for (const rule of rules) {
    try {
      findings.push(...(rule(ctx) || []))
    } catch (e) {
      errors.push({ rule: rule.name, message: e?.message || 'rule failed' })
    }
  }
  return { findings, errors }
}

// ── helpers ────────────────────────────────────────────────────────────────

function pick(ctx, docKey) {
  const d = (ctx.documents || {})[docKey]
  return Array.isArray(d) ? d[0] || null : d || null
}

const PER_YEAR = { weekly: 52, 'bi-weekly': 26, biweekly: 26, semimonthly: 24, 'semi-monthly': 24, monthly: 12 }

function monthlyFromStub(stub) {
  if (!stub) return null
  const gross = num(stub.grossPay)
  if (gross === null || gross <= 0) return null
  const per = PER_YEAR[String(stub.payFrequency || '').toLowerCase()]
  // Without a stated frequency the stub cannot be annualized, and guessing monthly would
  // manufacture a discrepancy out of a semi-monthly payer.
  return per ? (gross * per) / 12 : null
}

const divide = (a, b) => (a === null ? null : a / b)
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`

// "John A Smith" vs "John Smith" — same surname, same first initial.
function sharesSurnameAndInitial(a, b) {
  const pa = a.split(' ').filter(Boolean)
  const pb = b.split(' ').filter(Boolean)
  if (!pa.length || !pb.length) return false
  return pa[pa.length - 1] === pb[pb.length - 1] && pa[0][0] === pb[0][0]
}

// Compare street number + street name only: "123 Main St, Apt 4" and "123 Main Street" are the
// same property, and flagging them would train the processor to dismiss this rule.
function streetKey(addr) {
  const s = norm(addr).replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|place|pl)\b/g, '')
  const m = /^(\d+)\s+([a-z0-9 ]+?)(?:\s+(?:apt|unit|ste|suite|#).*)?$/.exec(s.trim())
  return m ? `${m[1]} ${m[2].trim()}` : s.trim()
}
