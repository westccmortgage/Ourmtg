import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStatementSummary, calculateStatementIncome, moneyNumber } from '../netlify/functions/_lib/statement-income.mjs'
import { extractPdfStatementSummaries } from '../netlify/functions/_lib/statement-pdf.mjs'

test('PDF extraction provider loads without executing package fixtures', () => {
  assert.equal(typeof extractPdfStatementSummaries, 'function')
})

test('money parser handles statement currency formats', () => {
  assert.equal(moneyNumber('$12,345.67'), 12345.67)
  assert.equal(moneyNumber('(1,250.00)'), -1250)
  assert.equal(moneyNumber('not money'), null)
})

test('extracts statement month and a summary deposit total', () => {
  const result = extractStatementSummary(`
    Statement period January 1, 2026 through January 31, 2026
    Beginning balance $4,000.00
    Total deposits and additions 18 $52,450.75
    Ending balance $8,200.00
  `)
  assert.deepEqual(result, {
    statementMonth: '2026-01-01',
    totalDeposits: 52450.75,
    extractionStatus: 'extracted',
  })
})

test('never invents values when statement text is incomplete', () => {
  const result = extractStatementSummary('Statement summary unavailable')
  assert.equal(result.totalDeposits, null)
  assert.equal(result.statementMonth, null)
  assert.equal(result.extractionStatus, 'needs_manual_entry')
})

test('business calculation applies exclusions, expense factor, and ownership', () => {
  const months = Array.from({ length: 12 }, (_, index) => ({
    statementMonth: `2025-${String(index + 1).padStart(2, '0')}-01`,
    totalDeposits: 20000,
    excludedDeposits: 2000,
    needsReview: false,
  }))
  const result = calculateStatementIncome({
    months,
    statementType: 'business',
    periodMonths: 12,
    expenseFactorPct: 50,
    ownershipPct: 80,
  })
  assert.equal(result.eligibleDeposits, 216000)
  assert.equal(result.averageMonthlyDeposits, 18000)
  assert.equal(result.qualifyingMonthlyIncome, 7200)
  assert.equal(result.readyForHumanReview, true)
})

test('personal statements do not apply a business expense factor', () => {
  const result = calculateStatementIncome({
    months: [{ statementMonth: '2026-01-01', totalDeposits: 10000, excludedDeposits: 1000, needsReview: false }],
    statementType: 'personal',
    periodMonths: 12,
    expenseFactorPct: 75,
    ownershipPct: 25,
  })
  assert.equal(result.qualifyingMonthlyIncome, 9000)
  assert.equal(result.expenseFactorPct, 0)
  assert.equal(result.ownershipPct, 100)
  assert.equal(result.missingMonths, 11)
  assert.equal(result.readyForHumanReview, false)
})

test('flags a material recent decline without making a decision', () => {
  const deposits = [10000, 10000, 10000, 7000, 7000, 7000]
  const result = calculateStatementIncome({
    months: deposits.map((totalDeposits, index) => ({
      statementMonth: `2026-${String(index + 1).padStart(2, '0')}-01`,
      totalDeposits,
      excludedDeposits: 0,
      needsReview: false,
    })),
    statementType: 'personal',
    periodMonths: 12,
  })
  assert.equal(result.trendPct, -30)
  assert.equal(result.decliningTrend, true)
})
