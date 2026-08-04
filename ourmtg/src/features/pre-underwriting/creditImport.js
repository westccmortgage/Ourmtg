// Credit liabilities → the 1003.
//
// Every obligation on the credit report has to end up in section 2c of the application, because
// that is what the ratios are computed from and what the borrower attests to. Doing it by hand
// is the single most tedious job in processing and the easiest one to get wrong by omission.
//
// ── What this module is careful about ───────────────────────────────────────
//
// MATCHING BEFORE IMPORTING. A borrower who already declared their car loan must not end up with
// it twice, and must not be told they failed to disclose it. Reconciliation comes first; the
// import only ever writes what is genuinely not there.
//
// CLOSED ACCOUNTS ARE NOT LIABILITIES. A paid-off card with a zero balance belongs on a credit
// report and not on a 1003. Importing it inflates the debt column and the DTI with it.
//
// A ZERO PAYMENT IS NOT A ZERO DEBT. A deferred student loan reports $0 and still counts —
// agencies require an imputed payment. So a zero payment with a balance is imported and flagged,
// never silently dropped and never treated as costing nothing.
//
// THE ACCOUNT NUMBER IS NEVER IMPORTED. `liabilities[].accountNumber` is a secure field with its
// own storage and its own control. Level 2 only ever reads the last four, and even that stays
// out of the application — it is a matching key here and nothing else.
//
// NOTHING IS WRITTEN AUTOMATICALLY. This module plans; a person presses the button. Writing into
// somebody's mortgage application is not a side effect of reading a PDF.

const LIABILITY_TYPES = Object.freeze([
  'mortgage', 'heloc', 'installment', 'revolving', 'lease', 'open_30_day',
  'alimony', 'child_support', 'separate_maintenance', 'job_related_expense', 'other',
])

// Credit vendors word these differently and there is no standard. Anything unrecognized becomes
// 'other' rather than a guess — a wrong type changes how the debt is treated in the ratios.
const TYPE_PATTERNS = [
  [/home\s*equity|heloc/i, 'heloc'],
  [/mortgage|real\s*estate/i, 'mortgage'],
  [/lease/i, 'lease'],
  [/revolv|credit\s*card|charge\s*card|bank\s*card/i, 'revolving'],
  [/install|auto\s*loan|student|education|personal\s*loan/i, 'installment'],
  [/open\s*(30|account)|open$/i, 'open_30_day'],
  [/child\s*support/i, 'child_support'],
  [/alimony/i, 'alimony'],
  [/separate\s*maintenance/i, 'separate_maintenance'],
]

/** Which of the catalog's liability types this tradeline is, conservatively. */
export function inferLiabilityType(tradeline = {}) {
  const text = `${tradeline.accountType || ''} ${tradeline.creditorName || ''}`
  for (const [re, type] of TYPE_PATTERNS) if (re.test(text)) return type
  return 'other'
}

// Statuses that mean the account is behind the borrower, not in front of them.
const CLOSED = /closed|paid|settled|transferred|sold|charge[\s-]?off|collection|zero\s*balance/i

/**
 * Should this tradeline become a liability on the application?
 *
 * @returns {{reportable: boolean, reason: string|null, needsPayment: boolean}}
 */
export function reportable(tradeline = {}) {
  const status = String(tradeline.status || '')
  const balance = num(tradeline.balance)
  const payment = num(tradeline.monthlyPayment)

  // A closed account with nothing owed is history. Importing it inflates the debt column.
  if (CLOSED.test(status) && (balance === null || balance <= 0)) {
    return { reportable: false, reason: 'closed with no balance', needsPayment: false }
  }
  if ((balance === null || balance <= 0) && (payment === null || payment <= 0)) {
    return { reportable: false, reason: 'no balance and no payment', needsPayment: false }
  }
  // Deferred student loans and similar report $0 and still count — the agencies require an
  // imputed payment. Import it, and say out loud that the payment has to be established.
  if ((payment === null || payment <= 0) && balance > 0) {
    return { reportable: true, reason: null, needsPayment: true }
  }
  return { reportable: true, reason: null, needsPayment: false }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Creditor names on a report and on an application are rarely spelled the same: "CHASE CARD
// SERVICES" vs "Chase". Match on the leading words rather than demanding equality, or the
// reconciliation reports everything as new and the whole feature becomes noise.
const creditorKey = (name) => norm(name).split(' ').filter(Boolean).slice(0, 2).join(' ')

/**
 * Which credit obligations the application already knows about.
 *
 * The last four digits are the strong signal and the creditor name is the fallback. Both are
 * compared; either one matching is a match, because a borrower who typed "Chase" for an account
 * they gave no number for has still disclosed it.
 *
 * @param {Array} tradelines   from the credit report
 * @param {Array} declared     from the application: {creditorName, accountLast4?}
 */
export function reconcile(tradelines = [], declared = []) {
  const byLast4 = new Map()
  const byName = new Map()
  for (const d of declared) {
    if (!d) continue
    const l4 = last4(d.accountLast4 ?? d.accountNumber)
    if (l4) byLast4.set(l4, d)
    const k = creditorKey(d.creditorName)
    if (k) byName.set(k, d)
  }

  const matched = []
  const onlyOnCredit = []
  const seen = new Set()

  for (const tl of tradelines) {
    if (!tl) continue
    const check = reportable(tl)
    const l4 = last4(tl.accountLast4)
    const key = creditorKey(tl.creditorName)
    const hit = (l4 && byLast4.get(l4)) || (key && byName.get(key)) || null

    if (hit) {
      seen.add(hit)
      matched.push({ tradeline: tl, declared: hit, ...disagreement(tl, hit) })
      continue
    }
    // Only what belongs on a 1003 becomes an import candidate. A closed card is neither
    // "undisclosed" nor importable — it is simply not a liability.
    if (check.reportable) onlyOnCredit.push({ tradeline: tl, needsPayment: check.needsPayment })
    else onlyOnCredit.push({ tradeline: tl, skip: true, reason: check.reason })
  }

  // Debts the borrower declared that the credit report does not show. Not an error and not
  // fraud — private loans, family debt, and support obligations are routinely absent from a
  // credit report, and they still count in the ratios.
  const onlyOnApplication = declared.filter((d) => d && !seen.has(d))

  return { matched, onlyOnCredit, onlyOnApplication }
}

/** Where a matched pair disagrees, so a processor sees it without opening both documents. */
function disagreement(tl, dec) {
  const out = []
  const tlPay = num(tl.monthlyPayment)
  const decPay = num(dec.monthlyPayment)
  if (tlPay !== null && decPay !== null && Math.abs(tlPay - decPay) > Math.max(10, tlPay * 0.1)) {
    out.push({ field: 'monthlyPayment', credit: tlPay, application: decPay })
  }
  const tlBal = num(tl.balance)
  const decBal = num(dec.unpaidBalance ?? dec.balance)
  if (tlBal !== null && decBal !== null && Math.abs(tlBal - decBal) > Math.max(100, tlBal * 0.2)) {
    out.push({ field: 'unpaidBalance', credit: tlBal, application: decBal })
  }
  return out.length ? { differs: out } : {}
}

/**
 * The field writes that would put the missing obligations into the application.
 *
 * Pure: returns a plan, writes nothing. Indices continue after whatever is already recorded, so
 * an import never overwrites a liability the borrower entered themselves.
 *
 * @param {object} input
 * @param {Array} input.tradelines
 * @param {Array} input.declared
 * @param {number} [input.partyIndex]
 * @param {number} [input.nextIndex]  first free liabilities[] slot
 * @returns {{writes: Array<{path, value}>, imported: Array, skipped: Array, needsPayment: Array}}
 */
export function planLiabilityImport({ tradelines = [], declared = [], partyIndex = 0, nextIndex = 0 } = {}) {
  const { onlyOnCredit } = reconcile(tradelines, declared)
  const writes = []
  const imported = []
  const skipped = []
  const needsPayment = []
  let i = nextIndex

  for (const row of onlyOnCredit) {
    if (row.skip) { skipped.push({ creditorName: row.tradeline.creditorName, reason: row.reason }); continue }
    const tl = row.tradeline
    const base = `parties[${partyIndex}].liabilities[${i}]`

    writes.push({ path: `${base}.creditorName`, value: String(tl.creditorName).slice(0, 120) })
    writes.push({ path: `${base}.liabilityType`, value: inferLiabilityType(tl) })

    const payment = num(tl.monthlyPayment)
    // A $0 payment is written as $0 and flagged, not omitted. Leaving the field empty would make
    // the debt look unanswered rather than look like what it is: a payment nobody has established.
    writes.push({ path: `${base}.monthlyPayment`, value: payment === null ? 0 : payment })

    const balance = num(tl.balance)
    if (balance !== null) writes.push({ path: `${base}.unpaidBalance`, value: balance })

    // Deliberately NOT written: accountNumber. It is a secure field with its own control, and
    // the last four we hold is a matching key rather than a value to publish into the file.

    imported.push({
      index: i,
      creditorName: tl.creditorName,
      liabilityType: inferLiabilityType(tl),
      monthlyPayment: payment,
      unpaidBalance: balance,
      confidence: tl.confidence ?? null,
    })
    if (row.needsPayment) {
      needsPayment.push({
        index: i,
        creditorName: tl.creditorName,
        unpaidBalance: balance,
        why: 'The report shows no monthly payment against a balance — deferred or in forbearance. The agencies require a payment to be established before this counts correctly.',
      })
    }
    i += 1
  }

  // The section is gated on an explicit yes/no; importing a debt without answering it leaves the
  // application saying "no debts" while listing several.
  if (imported.length) writes.unshift({ path: `parties[${partyIndex}].hasAnyLiabilities`, value: true })

  return { writes, imported, skipped, needsPayment }
}

/**
 * The liabilities already on the application, read out of the field-state projection.
 *
 * Exported because `undisclosedLiabilities` compares against this list, and comparing against an
 * empty one — which is what a stub returns — reports every obligation on the report as
 * undisclosed. Fifteen tradelines become fifteen high-severity findings and the panel is noise
 * on its first day.
 */
export function declaredLiabilities(fieldState = [], partyIndex = 0) {
  const rows = new Map()
  const re = new RegExp(`^parties\\[${partyIndex}\\]\\.liabilities\\[(\\d+)\\]\\.(\\w+)$`)
  for (const s of fieldState || []) {
    const m = re.exec(String(s?.field_path ?? s?.path ?? ''))
    if (!m) continue
    const [, idx, field] = m
    const value = unwrap(s.normalized_value ?? s.value)
    if (value === null || value === undefined) continue
    const row = rows.get(idx) || { index: Number(idx) }
    row[field] = value
    rows.set(idx, row)
  }
  // A row with no creditor cannot be matched against anything and is a half-entered record.
  return [...rows.values()].filter((r) => r.creditorName)
}

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v)

const last4 = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[$,\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export { LIABILITY_TYPES }
