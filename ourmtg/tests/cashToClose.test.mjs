// Cash-to-close planning engine tests (Phase 1B §10 — the 10 required cases).
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCashToClose } from '../src/domain/cashToClose.js'

test('1. $150k down payment but insufficient total cash → shortfall', () => {
  const r = computeCashToClose({ downPaymentAmount: 150000, lenderOrigination: 3000, cashIdentified: 120000 })
  assert.equal(r.downPayment, 150000)
  assert.ok(r.estimatedCashToClose >= 153000)
  assert.ok(r.estimatedShortfall > 0)
  assert.equal(r.estimatedSurplus, 0)
})

test('2. earnest money credit reduces cash to close', () => {
  const base = computeCashToClose({ downPaymentAmount: 50000, lenderOrigination: 4000 })
  const withEmd = computeCashToClose({ downPaymentAmount: 50000, lenderOrigination: 4000, earnestMoney: 10000 })
  assert.equal(withEmd.estimatedCashToClose, base.estimatedCashToClose - 10000)
  assert.equal(withEmd.depositsAndCredits, 10000)
})

test('3. seller credit reduces cash to close', () => {
  const r = computeCashToClose({ downPaymentAmount: 40000, lenderOrigination: 5000, sellerCredits: 6000 })
  assert.equal(r.depositsAndCredits, 6000)
  assert.equal(r.estimatedCashToClose, 40000 + 5000 - 6000)
})

test('4. discount points are a separate line from origination', () => {
  const r = computeCashToClose({ lenderOrigination: 2000, points: 3500, downPaymentAmount: 10000 })
  const orig = r.lines.find((l) => l.key === 'origination')
  const pts = r.lines.find((l) => l.key === 'points')
  assert.equal(orig.amount, 2000)
  assert.equal(pts.amount, 3500)
  assert.notEqual(orig.key, pts.key)
  assert.equal(r.grossClosingCosts, 5500) // both counted, still separate lines
})

test('5. post-closing reserves are separate from cash to close', () => {
  const r = computeCashToClose({ downPaymentAmount: 30000, lenderOrigination: 3000, reservesAfterClosing: 12000 })
  assert.equal(r.reservesRequirement, 12000)
  assert.equal(r.estimatedCashToClose, 33000) // reserves NOT added into cash to close
})

test('6. range estimate produces low/high', () => {
  const r = computeCashToClose({ downPaymentAmount: 20000, titleEscrow: { low: 1500, high: 2500 } })
  assert.ok(r.range.low < r.range.high)
  assert.equal(r.range.low, 21500)
  assert.equal(r.range.high, 22500)
})

test('7. verified override sets classification=verified', () => {
  const r = computeCashToClose({ downPaymentAmount: 25000, lenderOrigination: 3000, titleEscrow: 1500, verified: true })
  assert.equal(r.classification, 'verified')
})

test('8. final classification only from a verified final source (Closing Disclosure)', () => {
  const final = computeCashToClose({ downPaymentAmount: 25000, sourceType: 'closing_disclosure', verified: true, classification: 'final' })
  assert.equal(final.classification, 'final')
  // Requesting final WITHOUT a verified final source must NOT fabricate a final value.
  const faked = computeCashToClose({ downPaymentAmount: 25000, classification: 'final' })
  assert.notEqual(faked.classification, 'final')
})

test('9. missing inputs do not crash; classification stays low-confidence', () => {
  const r = computeCashToClose({})
  assert.equal(r.estimatedCashToClose, 0)
  assert.equal(r.grossClosingCosts, 0)
  assert.equal(r.classification, 'illustrative')
  assert.ok(Array.isArray(r.assumptions) && r.assumptions.length > 0)
})

test('10. credits exceeding costs show a SURPLUS, never negative cash to close', () => {
  const r = computeCashToClose({ downPaymentAmount: 5000, lenderOrigination: 1000, sellerCredits: 20000 })
  assert.equal(r.estimatedCashToClose, 0)       // clamped at zero
  assert.ok(r.creditSurplus > 0)                // surplus surfaced explicitly
})
