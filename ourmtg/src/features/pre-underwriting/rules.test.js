// The rule engine's job is to be worth reading. Two failure modes matter more than any others:
// firing on absence (which buries real findings under noise until the processor stops looking),
// and explaining a symptom instead of a reason ("income mismatch" tells them nothing they could
// not see themselves). Both are asserted here.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runRules, incomeConsistency, employmentTenure, employmentGap, largeDeposits,
  nameConsistency, propertyConsistency, undisclosedLiabilities, lowConfidenceExtractions,
} from './rules.js'
import { finding, evidence, resolve, triage, REVIEW_CONFIDENCE_THRESHOLD } from './findings.js'

const AS_OF = Date.parse('2026-07-30T00:00:00Z')
const base = { asOf: AS_OF, id: (k) => `f:${k}` }

// ── the record itself ───────────────────────────────────────────────────────
test('a finding exposes its weakest evidence, not an average', () => {
  const f = finding({
    rule: 'r', category: 'income', severity: 'low', explanation: 'x',
    evidence: [evidence('w2_2yr', 'a', 1, 0.99), evidence('paystubs_30d', 'b', 2, 0.62)],
  })
  // Averaging would let two confident reads paper over one bad one.
  assert.equal(f.minConfidence, 0.62)
  assert.equal(f.needsHumanReview, true)
  assert.deepEqual([...f.sourceDocuments], ['w2_2yr', 'paystubs_30d'])
})

test('a finding carries no confidence of its own', () => {
  const f = finding({ rule: 'r', category: 'income', severity: 'low', explanation: 'x', evidence: [] })
  assert.equal('confidence' in f, false)
  // Nothing model-read means nothing uncertain — not "we are unsure".
  assert.equal(f.minConfidence, null)
  assert.equal(f.needsHumanReview, false)
})

test('findings are internal and start unreviewed', () => {
  const f = finding({ rule: 'r', category: 'income', severity: 'low', explanation: 'x', evidence: [] })
  assert.equal(f.audience, 'team')
  assert.equal(f.status, 'pending_review')
})

test('an unknown category or severity is rejected rather than stored', () => {
  assert.throws(() => finding({ rule: 'r', category: 'vibes', severity: 'low', explanation: 'x' }))
  assert.throws(() => finding({ rule: 'r', category: 'income', severity: 'catastrophic', explanation: 'x' }))
})

test('resolving preserves what the agent originally said', () => {
  const f = finding({ rule: 'r', category: 'income', severity: 'high', explanation: 'x', evidence: [] })
  const done = resolve(f, { status: 'dismissed', by: 'u1', at: '2026-07-30', note: 'bonus year' })
  assert.equal(done.status, 'dismissed')
  assert.equal(done.explanation, f.explanation)
  assert.equal(f.status, 'pending_review')          // original untouched
  assert.throws(() => resolve(f, { status: 'pending_review' }))
})

test('triage puts what needs a person first', () => {
  const mk = (rule, severity, conf) => finding({
    rule, category: 'income', severity, explanation: 'x',
    evidence: conf === null ? [] : [evidence('d', 'f', 1, conf)],
  })
  const order = triage([mk('c', 'low', null), mk('a', 'high', null), mk('b', 'low', 0.5)]).map((f) => f.rule)
  assert.deepEqual(order, ['b', 'a', 'c'])
})

// ── low confidence ──────────────────────────────────────────────────────────
test('a value read with low confidence becomes a finding about our reading', () => {
  const out = lowConfidenceExtractions({
    ...base,
    extractions: [
      { docKey: 'w2_2yr', field: 'wagesTipsOther', value: 92000, confidence: 0.55 },
      { docKey: 'paystubs_30d', field: 'grossPay', value: 3400, confidence: 0.97 },
      { docKey: 'application', field: 'monthlyIncome', value: 8200, confidence: null },
    ],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].category, 'documents')
  assert.equal(out[0].needsHumanReview, true)
  assert.match(out[0].explanation, /55%/)
})

test('confidence exactly at the threshold is trusted', () => {
  const out = lowConfidenceExtractions({
    ...base,
    extractions: [{ docKey: 'w2_2yr', field: 'x', value: 1, confidence: REVIEW_CONFIDENCE_THRESHOLD }],
  })
  assert.equal(out.length, 0)
})

// ── income consistency ──────────────────────────────────────────────────────
const stub = (grossPay, payFrequency, extra = {}) => ({ grossPay, payFrequency, _confidence: 0.97, ...extra })

test('agreeing numbers produce no finding', () => {
  const out = incomeConsistency({
    ...base,
    application: { monthlyIncome: 8000 },
    documents: { paystubs_30d: [stub(4000, 'semimonthly')], w2_2yr: [{ wagesTipsOther: 96000, taxYear: 2025 }] },
  })
  assert.deepEqual(out, [])
})

test('one number alone is not a discrepancy', () => {
  // Firing here would flag every file before its documents arrive.
  assert.deepEqual(incomeConsistency({ ...base, application: { monthlyIncome: 8200 }, documents: {} }), [])
})

test('the user’s own example: the explanation names the reason, not the symptom', () => {
  const out = incomeConsistency({
    ...base,
    application: { monthlyIncome: 8200 },
    employment: { startDate: '2026-04-15' },        // ~3 months ago
    documents: { paystubs_30d: [stub(7450, 'monthly')], w2_2yr: [{ wagesTipsOther: 92000, taxYear: 2025 }] },
  })
  assert.equal(out.length, 1)
  const f = out[0]
  assert.equal(f.rule, 'income_consistency')
  assert.equal(f.category, 'income')
  // "Income mismatch." is exactly what this must not say.
  assert.doesNotMatch(f.explanation, /^income mismatch\.?$/i)
  assert.match(f.explanation, /different periods/i)
  assert.match(f.explanation, /months ago/i)
  assert.match(f.explanation, /human decision/i)
  assert.deepEqual([...f.sourceDocuments].sort(), ['application', 'paystubs_30d', 'w2_2yr'])
})

test('a stub with no stated frequency is not annualized by guessing', () => {
  // Assuming monthly would manufacture a discrepancy out of a semi-monthly payer.
  const out = incomeConsistency({
    ...base,
    application: { monthlyIncome: 8200 },
    documents: { paystubs_30d: [stub(4100, null)] },
  })
  assert.deepEqual(out, [])
})

// ── employment ──────────────────────────────────────────────────────────────
test('short tenure is flagged but not called disqualifying', () => {
  const out = employmentTenure({ ...base, employment: { startDate: '2026-04-15' } })
  assert.equal(out.length, 1)
  assert.equal(out[0].severity, 'high')
  assert.match(out[0].explanation, /not automatically disqualifying/i)
})

test('two years on the job produces nothing', () => {
  assert.deepEqual(employmentTenure({ ...base, employment: { startDate: '2020-01-01' } }), [])
  assert.deepEqual(employmentTenure({ ...base, employment: {} }), [])
})

test('a gap between jobs is measured, a normal handover is not', () => {
  const gap = employmentGap({
    ...base,
    employment: { history: [
      { employerName: 'Acme', startDate: '2019-01-01', endDate: '2024-02-01' },
      { employerName: 'Globex', startDate: '2024-11-01' },
    ] },
  })
  assert.equal(gap.length, 1)
  assert.match(gap[0].explanation, /Acme/)
  assert.match(gap[0].explanation, /Globex/)

  const clean = employmentGap({
    ...base,
    employment: { history: [
      { employerName: 'Acme', startDate: '2019-01-01', endDate: '2024-02-01' },
      { employerName: 'Globex', startDate: '2024-02-12' },
    ] },
  })
  assert.deepEqual(clean, [])
})

// ── deposits ────────────────────────────────────────────────────────────────
test('a large deposit is relative to income, not a fixed dollar figure', () => {
  const ctx = (monthlyIncome) => ({
    ...base, application: { monthlyIncome },
    deposits: [{ amount: 18500, date: '2026-06-11', docKey: 'bank_2mo', confidence: 0.98 }],
  })
  assert.equal(largeDeposits(ctx(8200)).length, 1)      // half a month of income → sourcing
  assert.equal(largeDeposits(ctx(80000)).length, 0)     // unremarkable at that income
  assert.match(largeDeposits(ctx(8200))[0].explanation, /\$18,500/)
})

test('no income means no threshold, so no deposit findings', () => {
  assert.deepEqual(largeDeposits({ ...base, application: {}, deposits: [{ amount: 50000 }] }), [])
})

// ── identity and property ───────────────────────────────────────────────────
test('a middle initial is not a name discrepancy', () => {
  const out = nameConsistency({
    ...base,
    extractions: [
      { docKey: 'id_photo', field: 'fullName', value: 'John Smith', confidence: 0.99 },
      { docKey: 'w2_2yr', field: 'employeeName', value: 'John A Smith', confidence: 0.98 },
    ],
  })
  assert.deepEqual(out, [])
})

test('a genuinely different name is flagged, and employers are not mistaken for people', () => {
  const out = nameConsistency({
    ...base,
    extractions: [
      { docKey: 'id_photo', field: 'fullName', value: 'John Smith', confidence: 0.99 },
      { docKey: 'bank_2mo', field: 'accountHolder', value: 'Jane Okonkwo', confidence: 0.95 },
      { docKey: 'w2_2yr', field: 'employerName', value: 'Globex Corporation', confidence: 0.99 },
    ],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].category, 'identity')
  assert.doesNotMatch(out[0].explanation, /globex/i)
})

test('an apartment number is not a different property; a different street is', () => {
  const same = propertyConsistency({
    ...base,
    extractions: [
      { docKey: 'purchase_contract', field: 'propertyAddress', value: '123 Main Street', confidence: 0.99 },
      { docKey: 'hoi_dec', field: 'propertyAddress', value: '123 Main St, Apt 4', confidence: 0.97 },
    ],
  })
  assert.deepEqual(same, [])

  const differs = propertyConsistency({
    ...base,
    extractions: [
      { docKey: 'purchase_contract', field: 'propertyAddress', value: '123 Main Street', confidence: 0.99 },
      { docKey: 'tax_bill', field: 'propertyAddress', value: '87 Oak Avenue', confidence: 0.97 },
    ],
  })
  assert.equal(differs.length, 1)
  assert.equal(differs[0].severity, 'high')
})

// ── liabilities ─────────────────────────────────────────────────────────────
test('a debt on the report but not the application is surfaced', () => {
  const out = undisclosedLiabilities({
    ...base,
    application: { liabilities: [{ creditorName: 'Chase Auto' }] },
    creditLiabilities: [
      { creditorName: 'Chase Auto', monthlyPayment: 450 },
      { creditorName: 'Sallie Mae', monthlyPayment: 310, confidence: 0.96 },
      { creditorName: 'Closed Card', monthlyPayment: 0 },   // nothing to count
    ],
  })
  assert.equal(out.length, 1)
  assert.match(out[0].explanation, /Sallie Mae/)
  assert.equal(out[0].severity, 'high')
})

// ── the engine ──────────────────────────────────────────────────────────────
test('one broken rule cannot take the analysis down', () => {
  const boom = () => { throw new Error('bad rule') }
  Object.defineProperty(boom, 'name', { value: 'boom' })
  const ok = () => [finding({ rule: 'ok', category: 'income', severity: 'low', explanation: 'x', evidence: [] })]
  const { findings, errors } = runRules(base, [boom, ok])
  assert.equal(findings.length, 1)
  assert.deepEqual(errors.map((e) => e.rule), ['boom'])
})

test('an empty file produces no findings at all', () => {
  // The strongest guard against noise: nothing uploaded, nothing to say.
  const { findings, errors } = runRules({ ...base, application: {}, documents: {}, extractions: [] })
  assert.deepEqual(findings, [])
  assert.deepEqual(errors, [])
})

test('every finding explains itself and points at its sources', () => {
  const { findings } = runRules({
    ...base,
    application: { monthlyIncome: 8200, liabilities: [] },
    employment: { startDate: '2026-04-15' },
    documents: { paystubs_30d: [stub(7450, 'monthly')], w2_2yr: [{ wagesTipsOther: 92000, taxYear: 2025 }] },
    deposits: [{ amount: 18500, date: '2026-06-11', docKey: 'bank_2mo', confidence: 0.98 }],
    extractions: [{ docKey: 'w2_2yr', field: 'wagesTipsOther', value: 92000, confidence: 0.55 }],
    creditLiabilities: [{ creditorName: 'Sallie Mae', monthlyPayment: 310 }],
  })
  assert.ok(findings.length >= 4)
  for (const f of findings) {
    assert.ok(f.explanation.length > 40, `too terse: ${f.rule}`)
    assert.ok(f.evidence.length > 0, `no provenance: ${f.rule}`)
    assert.equal(f.audience, 'team')
    assert.equal(f.status, 'pending_review')
  }
})

test('close amounts still fire when the documents cannot describe the same period', () => {
  // The insight the first draft missed: a W-2 for a year that ended before the job started
  // cannot describe that job, however similar the numbers look. A numeric tolerance alone
  // would pass this and hand a processor a qualifying income nobody should rely on.
  const out = incomeConsistency({
    ...base,
    application: { monthlyIncome: 8000 },
    employment: { startDate: '2026-04-15' },
    documents: { paystubs_30d: [stub(8000, 'monthly')], w2_2yr: [{ wagesTipsOther: 96000, taxYear: 2024 }] },
  })
  assert.equal(out.length, 1)
  assert.match(out[0].explanation, /ended before this job started|does not include this job/i)
})

test('a settled two-year job with agreeing numbers stays quiet', () => {
  const out = incomeConsistency({
    ...base,
    application: { monthlyIncome: 8000 },
    employment: { startDate: '2021-01-01' },
    documents: { paystubs_30d: [stub(8000, 'monthly')], w2_2yr: [{ wagesTipsOther: 96000, taxYear: 2025 }] },
  })
  assert.deepEqual(out, [])
})

test('the bank statement’s account holder is checked against the ID', () => {
  // accountHolder has no "name" in it; a name-shaped regex misses the single document most
  // likely to be in someone else's name.
  const out = nameConsistency({
    ...base,
    extractions: [
      { docKey: 'id_photo', field: 'fullName', value: 'John Smith', confidence: 0.99 },
      { docKey: 'bank_2mo', field: 'accountHolder', value: 'Maria Delgado', confidence: 0.96 },
    ],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].category, 'identity')
})
