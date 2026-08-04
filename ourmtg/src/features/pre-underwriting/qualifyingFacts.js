// Autopilot Pre-Underwriting — the four numbers everything else turns on.
//
//     qualifying income · monthly debt · DTI · LTV · the representative credit score
//
// These are the numbers a processor would compute by hand from the documents, and the ones the
// program list is measured against. They are computed here, deterministically, from what was
// actually read — never estimated, never defaulted, and null the moment an input is missing.
//
// ── Why null matters more than the arithmetic ───────────────────────────────
// A DTI computed from an income we do not have is not a conservative estimate; it is a wrong
// number that looks like a right one, and it will be quoted to a borrower. Every function here
// returns null rather than a guess, and every result says which inputs it used — so a panel can
// show "DTI: not yet computable, we still need X" instead of a confident 38%.
//
// ── The credit score rule is not "the average" ──────────────────────────────
// Mortgage lending uses the MIDDLE of the three bureau scores, and with two borrowers, the
// LOWER of their two middles. Averaging is the intuitive thing and it is wrong in a direction
// that qualifies people who do not qualify.

import { getDocumentType } from './documentCatalog.js'

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[$,%\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const PER_YEAR = {
  weekly: 52, 'bi-weekly': 26, biweekly: 26, 'semi-monthly': 24, semimonthly: 24, monthly: 12,
}

/**
 * The representative score for one borrower: the middle of the three bureaus.
 *
 * Two scores → the lower. One score → that one, but flagged as not a tri-merge, because a single
 * bureau cannot produce a middle score and using it as one is how a file gets priced wrong.
 *
 * @returns {{score: number|null, basis: string, bureaus: number}}
 */
export function representativeScore(scores) {
  const values = (Array.isArray(scores) ? scores : [scores?.equifax, scores?.experian, scores?.transUnion])
    .map(num)
    .filter((n) => n !== null && n >= 300 && n <= 850)
    .sort((a, b) => a - b)

  if (values.length === 0) return { score: null, basis: 'no credit report read', bureaus: 0 }
  if (values.length === 1) return { score: values[0], basis: 'single bureau — not a middle score', bureaus: 1 }
  if (values.length === 2) return { score: values[0], basis: 'lower of two bureaus', bureaus: 2 }
  return { score: values[1], basis: 'middle of three bureaus', bureaus: 3 }
}

/** With more than one borrower, the file's score is the LOWER of their representative scores. */
export function fileScore(perBorrower) {
  const rows = (perBorrower || []).filter((r) => r && r.score !== null)
  if (rows.length === 0) return { score: null, basis: 'no credit report read', bureaus: 0 }
  return rows.reduce((lowest, r) => (r.score < lowest.score ? r : lowest))
}

/**
 * Monthly qualifying income, preferring what is documented over what is stated.
 *
 * Deliberately NOT an average of the three sources. When a stub and a W-2 disagree, that is a
 * finding (incomeConsistency), not a number to smooth over — averaging would hide the very
 * discrepancy the rule exists to raise, and quietly produce an income nobody can support.
 */
export function qualifyingIncome({ documents = {}, application = {} } = {}) {
  const stub = documents.paystubs_30d?.[0]
  const fromStub = monthlyFromStub(stub)
  if (fromStub !== null) {
    return { monthly: fromStub, basis: 'pay stub', source: 'paystubs_30d', documented: true }
  }

  const w2 = documents.w2_2yr?.[0]
  const fromW2 = w2 ? divide(num(w2.wagesTipsOther), 12) : null
  if (fromW2 !== null) {
    return { monthly: fromW2, basis: 'W-2 wages ÷ 12', source: 'w2_2yr', documented: true }
  }

  const stated = num(application.monthlyIncome)
  if (stated !== null && stated > 0) {
    // Usable for a first look, and marked so nothing downstream mistakes it for verified.
    return { monthly: stated, basis: 'stated on the application, not yet documented', source: 'application', documented: false }
  }
  return { monthly: null, basis: 'no income document read', source: null, documented: false }
}

function monthlyFromStub(stub) {
  if (!stub) return null
  const gross = num(stub.grossPay)
  if (gross === null || gross <= 0) return null
  const freq = String(stub.payFrequency || '').toLowerCase().replace(/\s+/g, '-')
  const perYear = PER_YEAR[freq]
  if (perYear) return round2((gross * perYear) / 12)
  // No frequency means we cannot annualize, and assuming monthly would understate a weekly
  // payer's income by more than four times.
  return null
}

/**
 * Monthly obligations from the credit report.
 *
 * Only what the report actually shows a payment for. A tradeline with no payment is not a zero
 * — it is a number we do not have — and treating it as zero is exactly how a DTI comes out too
 * low. Those are counted and reported so the gap is visible.
 */
export function monthlyDebt({ creditLiabilities = [] } = {}) {
  let total = 0
  let counted = 0
  let unknown = 0
  for (const l of creditLiabilities) {
    const p = num(l.monthlyPayment)
    if (p === null || p <= 0) { unknown += 1; continue }
    total += p
    counted += 1
  }
  if (counted === 0 && unknown === 0) {
    return { monthly: null, counted: 0, unknownPayments: 0, basis: 'no credit report read' }
  }
  return {
    monthly: round2(total),
    counted,
    unknownPayments: unknown,
    basis: unknown > 0
      ? `${counted} account${counted === 1 ? '' : 's'} with a stated payment; ${unknown} without one`
      : `${counted} account${counted === 1 ? '' : 's'}`,
  }
}

/**
 * Debt-to-income. Returns null unless every input exists.
 *
 * The proposed housing payment is part of the back-end ratio and this system does not have it
 * until a loan is structured — so what is returned says which ratio it is, and a caller that
 * has no housing figure gets the honest partial one, labelled.
 */
export function debtToIncome({ income, debt, proposedHousing = null } = {}) {
  const monthlyIncome = income?.monthly ?? null
  const monthlyDebts = debt?.monthly ?? null
  if (monthlyIncome === null || monthlyIncome <= 0 || monthlyDebts === null) {
    return { percent: null, kind: null, missing: missingFor(monthlyIncome, monthlyDebts) }
  }
  const housing = num(proposedHousing)
  const total = monthlyDebts + (housing ?? 0)
  return {
    percent: round2((total / monthlyIncome) * 100),
    // Naming the ratio matters: a back-end DTI of 41% and a front-end 41% mean different things
    // and are compared against different guideline numbers.
    kind: housing === null ? 'debts only (no proposed housing payment yet)' : 'back-end',
    includesHousing: housing !== null,
    missing: housing === null ? ['proposed housing payment'] : [],
    documented: Boolean(income?.documented),
  }
}

const missingFor = (income, debt) => [
  income === null || income <= 0 ? 'qualifying income' : null,
  debt === null ? 'monthly obligations from the credit report' : null,
].filter(Boolean)

/**
 * Loan-to-value. Uses the LOWER of purchase price and appraised value when both exist, which is
 * the rule — a property that appraised high does not raise the borrowable amount on a purchase.
 */
export function loanToValue({ loanAmount, purchasePrice, appraisedValue } = {}) {
  const loan = num(loanAmount)
  const price = num(purchasePrice)
  const appraised = num(appraisedValue)
  const values = [price, appraised].filter((v) => v !== null && v > 0)
  if (loan === null || loan <= 0 || values.length === 0) {
    return {
      percent: null,
      missing: [
        loan === null || loan <= 0 ? 'loan amount' : null,
        values.length === 0 ? 'purchase price or appraised value' : null,
      ].filter(Boolean),
    }
  }
  const basis = Math.min(...values)
  return {
    percent: round2((loan / basis) * 100),
    basisValue: basis,
    // Said explicitly, because "the appraisal came in high" is a conversation that happens on
    // most purchases and the answer is always the same.
    basis: values.length === 2 ? 'lower of purchase price and appraised value' : (price !== null ? 'purchase price' : 'appraised value'),
  }
}

/**
 * Everything above, from one analysis context. This is what the panel calls.
 *
 * @returns {{creditScore, income, debt, dti, ltv, ready: boolean, missing: string[]}}
 */
export function qualifyingFacts(ctx = {}, application = {}) {
  const documents = ctx.documents || {}
  const credit = documents.credit_report?.[0] || {}

  const score = fileScore([representativeScore({
    equifax: credit.equifaxScore,
    experian: credit.experianScore,
    transUnion: credit.transUnionScore,
  })])

  const income = qualifyingIncome({ documents, application })
  const debt = monthlyDebt({ creditLiabilities: ctx.creditLiabilities })
  const dti = debtToIncome({ income, debt, proposedHousing: application.proposedHousingPayment })

  const contract = documents.purchase_contract?.[0] || {}
  const ltv = loanToValue({
    loanAmount: application.loanAmount,
    // The signed contract is authoritative; the borrower's own stated price serves until one is
    // read, so LTV does not sit at "not computable" for the whole early life of the file.
    purchasePrice: contract.purchasePrice ?? application.purchasePrice,
    appraisedValue: application.appraisedValue,
  })

  const missing = [
    score.score === null ? 'credit score' : null,
    income.monthly === null ? 'qualifying income' : null,
    dti.percent === null ? 'debt-to-income' : null,
    ltv.percent === null ? 'loan-to-value' : null,
  ].filter(Boolean)

  return {
    creditScore: score,
    income,
    debt,
    dti,
    ltv,
    ready: missing.length === 0,
    missing,
    // What each number came from, so the panel can show its work instead of asserting.
    sources: Object.keys(documents).filter((k) => getDocumentType(k)),
  }
}

const round2 = (n) => Math.round(n * 100) / 100
const divide = (a, b) => (a === null || !b ? null : round2(a / b))
