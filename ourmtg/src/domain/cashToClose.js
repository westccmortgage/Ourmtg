// Phase 1B — deterministic cash-to-close PLANNING engine (pure, no I/O, no Date).
//
// Produces a planning estimate ONLY. It never implies a lender quote or a final escrow figure.
// A 'final' classification is allowed ONLY when a verified final source (a Closing Disclosure)
// is supplied. Rules enforced:
//   • down payment is NEVER merged with closing costs
//   • discount points are ALWAYS a separate line from origination
//   • post-closing reserves are a separate REQUIREMENT, never a closing fee, never in cash-to-close
//   • earnest money + credits REDUCE cash needed
//   • cash-to-close never goes below zero — a negative result is shown as a SURPLUS
//   • ranges supported; no fabricated verified values
//
// A monetary input may be a number, or a range { low, high }, or { amount }. Missing → 0.

import { CASH_CLASSIFICATION, FINAL_SOURCE_TYPES } from './lifecycles.js'

function normMoney(v) {
  if (v == null) return { value: 0, low: 0, high: 0, provided: false }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, low: v, high: v, provided: true } : { value: 0, low: 0, high: 0, provided: false }
  if (typeof v === 'object') {
    if (typeof v.amount === 'number') return { value: v.amount, low: v.amount, high: v.amount, provided: true }
    const low = Number(v.low); const high = Number(v.high)
    if (Number.isFinite(low) || Number.isFinite(high)) {
      const lo = Number.isFinite(low) ? low : high
      const hi = Number.isFinite(high) ? high : low
      return { value: (lo + hi) / 2, low: lo, high: hi, provided: true }
    }
  }
  return { value: 0, low: 0, high: 0, provided: false }
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// Determine the accuracy classification. 'final' requires an explicit final source; 'verified'
// requires the caller to assert verification. Otherwise 'estimated', or 'illustrative' when
// inputs are too sparse to be meaningful.
function classify(inputs, providedCount) {
  const src = String(inputs.sourceType || '')
  if (inputs.classification === 'final' || FINAL_SOURCE_TYPES.includes(src)) {
    // Guard: final is ONLY honored with a verified final source — never fabricated.
    if (FINAL_SOURCE_TYPES.includes(src) && inputs.verified === true) return 'final'
    return 'estimated' // requested final but no verified final source → downgrade, do not fake it
  }
  if (inputs.verified === true) return 'verified'
  if (providedCount <= 2) return 'illustrative'
  return 'estimated'
}

export function computeCashToClose(inputs = {}) {
  const line = (key, label, raw, kind, explanation) => {
    const m = normMoney(raw)
    return { key, label, kind, amount: round2(m.value), low: round2(m.low), high: round2(m.high), provided: m.provided, explanation }
  }

  // ── Down payment (kept entirely separate from closing costs) ──
  let dpValue = normMoney(inputs.downPaymentAmount)
  const purchasePrice = normMoney(inputs.purchasePrice).value
  const loanAmount = normMoney(inputs.loanAmount).value
  if (!dpValue.provided) {
    if (inputs.downPaymentPercent != null && purchasePrice) {
      const amt = purchasePrice * (Number(inputs.downPaymentPercent) / 100)
      dpValue = { value: amt, low: amt, high: amt, provided: true }
    } else if (purchasePrice && loanAmount) {
      const amt = Math.max(0, purchasePrice - loanAmount)
      dpValue = { value: amt, low: amt, high: amt, provided: true }
    }
  }
  const downPayment = { key: 'down_payment', label: 'Down payment', kind: 'down_payment', amount: round2(dpValue.value), low: round2(dpValue.low), high: round2(dpValue.high), provided: dpValue.provided, explanation: 'Your equity contribution. Kept separate from closing costs.' }

  // ── Closing cost lines (points ALWAYS separate from origination) ──
  const closingLines = [
    line('origination', 'Lender / origination fee', inputs.lenderOrigination, 'closing_cost', 'Lender fees to make the loan (planning estimate).'),
    line('points', 'Discount points', inputs.points, 'closing_cost', 'Optional fee to buy down your rate — a separate line from origination.'),
    line('appraisal_third_party', 'Appraisal & third-party', inputs.appraisalThirdParty, 'closing_cost', 'Appraisal and other third-party services (planning estimate).'),
    line('title_escrow', 'Title & escrow', inputs.titleEscrow, 'closing_cost', 'Title insurance and escrow/settlement charges (planning estimate).'),
    line('recording_government', 'Recording & government', inputs.recordingGovernment, 'closing_cost', 'Government recording and transfer charges (planning estimate).'),
  ]
  // ── Prepaid / escrow-funding lines (distinct bucket; impounds fund the escrow account) ──
  const prepaidLines = [
    line('prepaid_interest', 'Prepaid interest', inputs.prepaidInterest, 'prepaid', 'Interest from closing to month-end (planning estimate).'),
    line('homeowners_insurance', 'Homeowners insurance', inputs.homeownersInsurance, 'prepaid', 'Upfront homeowners insurance (planning estimate).'),
    line('escrow_reserves', 'Tax & insurance escrow (impounds)', inputs.taxAndInsuranceReserves, 'prepaid', 'Initial escrow funding for taxes/insurance — part of cash to close, NOT post-closing reserves.'),
  ]
  // ── Deposits & credits (REDUCE cash to close) ──
  const creditLines = [
    line('earnest_money', 'Earnest money already paid', inputs.earnestMoney, 'credit', 'Deposit you already paid — reduces remaining cash to close.'),
    line('seller_credit', 'Seller credit', inputs.sellerCredits, 'credit', 'Credit from the seller — reduces cash to close.'),
    line('lender_credit', 'Lender credit', inputs.lenderCredits, 'credit', 'Credit from the lender — reduces cash to close.'),
    line('other_credit', 'Other credits', inputs.otherCredits, 'credit', 'Any other applicable credits — reduces cash to close.'),
  ]

  const sum = (arr, f = (x) => x.amount) => round2(arr.reduce((a, x) => a + f(x), 0))
  const grossClosingCosts = sum(closingLines)
  const prepaidItems = sum(prepaidLines)
  const depositsAndCredits = sum(creditLines)
  const grossClosingLow = sum(closingLines, (x) => x.low)
  const grossClosingHigh = sum(closingLines, (x) => x.high)
  const prepaidLow = sum(prepaidLines, (x) => x.low)
  const prepaidHigh = sum(prepaidLines, (x) => x.high)

  // ── Cash to close = down payment + closing costs + prepaids − credits (reserves EXCLUDED) ──
  const rawValue = round2(downPayment.amount + grossClosingCosts + prepaidItems - depositsAndCredits)
  const rawLow = round2(downPayment.low + grossClosingLow + prepaidLow - depositsAndCredits)
  const rawHigh = round2(downPayment.high + grossClosingHigh + prepaidHigh - depositsAndCredits)
  // Never negative: a negative requirement is a SURPLUS, not "negative cash needed".
  const estimatedCashToClose = round2(Math.max(0, rawValue))
  const creditSurplus = rawValue < 0 ? round2(-rawValue) : 0

  // ── Post-closing reserves REQUIREMENT — separate output, NOT part of cash to close ──
  const reservesRequirement = round2(normMoney(inputs.reservesAfterClosing).value)

  // ── Shortfall / surplus vs cash the borrower has identified ──
  const cashIdentified = round2(normMoney(inputs.cashIdentified).value)
  const net = round2(cashIdentified - estimatedCashToClose)
  const estimatedShortfall = net < 0 ? round2(-net) : 0
  const estimatedSurplus = net > 0 ? round2(net) : 0

  const allLines = [downPayment, ...closingLines, ...prepaidLines, ...creditLines]
  const providedCount = allLines.filter((l) => l.provided).length + (inputs.reservesAfterClosing != null ? 1 : 0)
  const classification = classify(inputs, providedCount)

  const assumptions = [
    'All figures are planning estimates unless marked verified or final.',
    'Down payment is shown separately from closing costs.',
    'Discount points are a separate line from origination.',
    'Post-closing reserves are a separate requirement and are NOT included in cash to close.',
    'Earnest money and credits reduce the cash you need to bring.',
    ...(CASH_CLASSIFICATION.includes(classification) ? [`Accuracy classification: ${classification}.`] : []),
    ...(classification !== 'final' ? ['Not a lender quote or a final escrow figure.'] : ['Based on a verified Closing Disclosure.']),
  ]

  return {
    downPayment: downPayment.amount,
    grossClosingCosts,
    prepaidItems,
    depositsAndCredits,
    estimatedCashToClose,
    range: { low: round2(Math.max(0, rawLow)), high: round2(Math.max(0, rawHigh)) },
    creditSurplus,
    reservesRequirement,
    cashIdentified,
    estimatedShortfall,
    estimatedSurplus,
    classification,
    lines: allLines,
    assumptions,
    calculatedAt: inputs.asOf || null, // caller stamps the time; pure module never reads a clock
  }
}
