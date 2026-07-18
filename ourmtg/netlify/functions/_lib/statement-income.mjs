// Deterministic bank-statement income analysis.
//
// PDF extraction may suggest a statement month and total deposits, but it never makes
// a lending decision. The calculator below only operates on explicit numeric inputs and
// every extracted month remains review-required until a loan-team user confirms it.

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100

export function moneyNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const cleaned = String(value || '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return null
  const number = Number(cleaned)
  return Number.isFinite(number) ? number : null
}

function monthKeyFromDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function statementMonth(text) {
  const candidates = []
  const numeric = /\b(0?[1-9]|1[0-2])[\/-](0?[1-9]|[12]\d|3[01])[\/-](20\d{2})\b/g
  for (const match of text.matchAll(numeric)) {
    candidates.push(new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]))))
  }

  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/gi
  for (const match of text.matchAll(named)) {
    candidates.push(new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`))
  }

  const valid = candidates.filter((date) => !Number.isNaN(date.getTime()))
  if (!valid.length) return null
  valid.sort((a, b) => b.getTime() - a.getTime())
  return monthKeyFromDate(valid[0])
}

const DEPOSIT_LABELS = [
  /total\s+deposits(?:\s+and\s+additions)?/i,
  /deposits\s+and\s+other\s+credits/i,
  /total\s+deposits\s*\/\s*credits/i,
  /total\s+credits/i,
  /deposits\s+\/\s*credits/i,
]

function depositsFromLines(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (const label of DEPOSIT_LABELS) {
    for (const line of lines) {
      if (!label.test(line)) continue
      const amounts = [...line.matchAll(/\(?\$?\s*\d[\d,]*\.\d{2}\)?/g)]
      if (!amounts.length) continue
      const amount = moneyNumber(amounts[amounts.length - 1][0])
      if (amount != null && amount >= 0) return amount
    }
  }
  return null
}

export function extractStatementSummary(text) {
  const source = String(text || '').trim()
  if (!source) {
    return { statementMonth: null, totalDeposits: null, extractionStatus: 'unreadable' }
  }
  const month = statementMonth(source)
  const totalDeposits = depositsFromLines(source)
  return {
    statementMonth: month,
    totalDeposits,
    extractionStatus: month && totalDeposits != null ? 'extracted' : 'needs_manual_entry',
  }
}

function pct(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : fallback
}

export function calculateStatementIncome({
  months = [],
  statementType = 'business',
  periodMonths = 12,
  expenseFactorPct = statementType === 'business' ? 50 : 0,
  ownershipPct = 100,
} = {}) {
  if (!['personal', 'business'].includes(statementType)) throw new Error('Invalid statement type')
  if (![12, 24].includes(Number(periodMonths))) throw new Error('Period must be 12 or 24 months')

  const expenseFactor = statementType === 'business' ? pct(expenseFactorPct, 50) : 0
  const ownership = statementType === 'business' ? pct(ownershipPct, 100) : 100
  const monthTotals = new Map()
  let totalDeposits = 0
  let excludedDeposits = 0
  let unreadableStatements = 0
  let reviewRequired = 0

  for (const row of months || []) {
    const total = Math.max(0, Number(row.totalDeposits) || 0)
    const excluded = Math.min(total, Math.max(0, Number(row.excludedDeposits) || 0))
    if (!row.statementMonth) {
      unreadableStatements++
      continue
    }
    const key = String(row.statementMonth).slice(0, 7)
    const current = monthTotals.get(key) || { total: 0, excluded: 0 }
    current.total += total
    current.excluded += excluded
    monthTotals.set(key, current)
    totalDeposits += total
    excludedDeposits += excluded
    if (row.needsReview !== false) reviewRequired++
  }

  const monthsCovered = monthTotals.size
  const eligibleDeposits = Math.max(0, totalDeposits - excludedDeposits)
  const averageMonthlyDeposits = monthsCovered ? eligibleDeposits / monthsCovered : 0
  const qualifyingMonthlyIncome = averageMonthlyDeposits
    * (1 - expenseFactor / 100)
    * (ownership / 100)

  const ordered = [...monthTotals.entries()].sort(([a], [b]) => a.localeCompare(b))
  let trendPct = null
  let decliningTrend = false
  if (ordered.length >= 6) {
    const eligible = ordered.map(([, value]) => Math.max(0, value.total - value.excluded))
    const recent = eligible.slice(-3).reduce((sum, value) => sum + value, 0) / 3
    const prior = eligible.slice(-6, -3).reduce((sum, value) => sum + value, 0) / 3
    if (prior > 0) {
      trendPct = roundMoney(((recent - prior) / prior) * 100)
      decliningTrend = trendPct < -10
    }
  }

  return {
    statementType,
    periodMonths: Number(periodMonths),
    monthsCovered,
    missingMonths: Math.max(0, Number(periodMonths) - monthsCovered),
    totalDeposits: roundMoney(totalDeposits),
    excludedDeposits: roundMoney(excludedDeposits),
    eligibleDeposits: roundMoney(eligibleDeposits),
    averageMonthlyDeposits: roundMoney(averageMonthlyDeposits),
    expenseFactorPct: expenseFactor,
    ownershipPct: ownership,
    qualifyingMonthlyIncome: roundMoney(qualifyingMonthlyIncome),
    trendPct,
    decliningTrend,
    unreadableStatements,
    reviewRequired,
    readyForHumanReview: monthsCovered === Number(periodMonths) && unreadableStatements === 0,
  }
}
