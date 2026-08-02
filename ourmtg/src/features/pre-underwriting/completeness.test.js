// Completeness is the one thing in this feature that must never be a judgement call. If it says
// a file is complete when a month is missing, the processor stops looking — which is worse than
// having built nothing. These tests are that guarantee.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessCompleteness, missingForFile, documentReadiness } from './completeness.js'
import { DOCUMENT_TYPES, getDocumentType, isKnownDocumentType } from './documentCatalog.js'

const AS_OF = Date.parse('2026-07-30T00:00:00Z')
const at = { asOf: AS_OF }
const codes = (r) => r.gaps.map((g) => g.code)

// ── nothing at all ──────────────────────────────────────────────────────────
test('a document that was never sent is incomplete, not silently fine', () => {
  const r = assessCompleteness('bank_2mo', [], at)
  assert.equal(r.complete, false)
  assert.deepEqual(codes(r), ['not_provided'])
})

test('an unrecognized type never reports complete', () => {
  const r = assessCompleteness('not_a_real_doc', [{}], at)
  assert.equal(r.complete, false)
  assert.deepEqual(codes(r), ['unknown_type'])
})

// ── bank statements ─────────────────────────────────────────────────────────
const stmt = (statementMonth, extra = {}) => ({ statementMonth, statementEnd: `${statementMonth}-28`, ...extra })

test('two consecutive recent months is complete', () => {
  const r = assessCompleteness('bank_2mo', [stmt('2026-06'), stmt('2026-07')], at)
  assert.equal(r.complete, true, JSON.stringify(r.gaps))
})

test('a hole between statement months is named, not summarized', () => {
  const r = assessCompleteness('bank_12mo', [stmt('2026-01'), stmt('2026-03'), stmt('2026-07')], at)
  assert.ok(codes(r).includes('gap_in_months'))
  const msg = r.gaps.find((g) => g.code === 'gap_in_months').message
  // Naming the months is the difference between one upload and re-checking a year of statements.
  assert.match(msg, /February 2026/)
  assert.match(msg, /April 2026/)
  assert.match(msg, /June 2026/)
})

test('missing pages are caught even when the months look right', () => {
  const r = assessCompleteness('bank_2mo', [
    stmt('2026-06', { pagesPresent: 2, pagesTotal: 7 }),
    stmt('2026-07', { pagesPresent: 7, pagesTotal: 7 }),
  ], at)
  assert.equal(r.complete, false)
  assert.ok(codes(r).includes('missing_pages'))
})

test('old statements are flagged as stale', () => {
  const r = assessCompleteness('bank_2mo', [stmt('2025-11'), stmt('2025-12')], at)
  assert.ok(codes(r).includes('stale'))
})

// ── pay stubs: coverage in days, not a count of files ───────────────────────
const stub = (start, end) => ({ payPeriodStart: start, payPeriodEnd: end, periodEnd: end })

test('one monthly stub covers thirty days', () => {
  const r = assessCompleteness('paystubs_30d', [stub('2026-06-29', '2026-07-28')], at)
  assert.equal(r.complete, true, JSON.stringify(r.gaps))
})

test('four weekly stubs back to back also cover it', () => {
  // Adjacent periods touch rather than overlap; treating that as a gap would fail every borrower
  // on a normal pay schedule.
  const r = assessCompleteness('paystubs_30d', [
    stub('2026-06-29', '2026-07-05'), stub('2026-07-06', '2026-07-12'),
    stub('2026-07-13', '2026-07-19'), stub('2026-07-20', '2026-07-28'),
  ], at)
  assert.equal(r.complete, true, JSON.stringify(r.gaps))
})

test('two stubs are not enough when they leave a hole', () => {
  const r = assessCompleteness('paystubs_30d', [
    stub('2026-06-29', '2026-07-05'), stub('2026-07-20', '2026-07-26'),
  ], at)
  assert.equal(r.complete, false)
  assert.ok(codes(r).includes('short_coverage') || codes(r).includes('gap_in_coverage'))
})

test('an unreadable pay period asks for the dates rather than guessing', () => {
  const r = assessCompleteness('paystubs_30d', [{ grossPay: 3200 }], at)
  assert.ok(codes(r).includes('unreadable_period'))
})

// ── identity ────────────────────────────────────────────────────────────────
test('one side of an ID is not both sides', () => {
  const r = assessCompleteness('id_photo', [{ side: 'front', expirationDate: '2030-01-01' }], at)
  assert.equal(r.complete, false)
  assert.ok(codes(r).includes('missing_side'))
})

test('an expired ID is refused even with both sides', () => {
  const r = assessCompleteness('id_photo', [
    { side: 'front', expirationDate: '2024-01-01' }, { side: 'back', expirationDate: '2024-01-01' },
  ], at)
  assert.equal(r.complete, false)
  assert.ok(codes(r).includes('expired'))
})

test('front and back, unexpired, is complete', () => {
  const r = assessCompleteness('id_photo', [
    { side: 'front', expirationDate: '2030-01-01' }, { side: 'back', expirationDate: '2030-01-01' },
  ], at)
  assert.equal(r.complete, true, JSON.stringify(r.gaps))
})

// ── insurance and taxes ─────────────────────────────────────────────────────
test('a lapsed policy is not current coverage', () => {
  const r = assessCompleteness('hoi_dec', [{ policyStart: '2024-01-01', policyEnd: '2025-01-01' }], at)
  assert.ok(codes(r).includes('policy_not_current'))
})

test('a policy covering today is complete', () => {
  const r = assessCompleteness('hoi_dec', [{ policyStart: '2026-03-01', policyEnd: '2027-03-01' }], at)
  assert.equal(r.complete, true, JSON.stringify(r.gaps))
})

test('W-2s need two distinct years', () => {
  assert.equal(assessCompleteness('w2_2yr', [{ taxYear: 2025 }], at).complete, false)
  assert.equal(assessCompleteness('w2_2yr', [{ taxYear: 2025 }, { taxYear: 2025 }], at).complete, false)
  assert.equal(assessCompleteness('w2_2yr', [{ taxYear: 2025 }, { taxYear: 2024 }], at).complete, true)
})

// ── contracts ───────────────────────────────────────────────────────────────
test('an unsigned contract is incomplete; unknown signing is not assumed bad', () => {
  assert.ok(codes(assessCompleteness('purchase_contract', [{ signedByAllParties: false }], at)).includes('unsigned'))
  // Nothing extracted about signatures must not manufacture a gap — that would send borrowers
  // chasing a document they already provided correctly.
  assert.equal(assessCompleteness('purchase_contract', [{}], at).complete, true)
})

// ── file-level rollups ──────────────────────────────────────────────────────
const CHECKLIST = [{ docKey: 'id_photo' }, { docKey: 'paystubs_30d' }, { docKey: 'bank_2mo' }, { docKey: 'w2_2yr' }]

test('the missing list names only what is outstanding', () => {
  const byType = {
    id_photo: [{ side: 'front', expirationDate: '2030-01-01' }, { side: 'back', expirationDate: '2030-01-01' }],
    paystubs_30d: [stub('2026-06-29', '2026-07-28')],
    bank_2mo: [stmt('2026-07')],
    w2_2yr: [],
  }
  const missing = missingForFile(CHECKLIST, byType, at)
  assert.deepEqual(missing.map((m) => m.docKey), ['bank_2mo', 'w2_2yr'])
  assert.ok(missing.every((m) => m.gaps.length > 0))
})

test('readiness counts documents, not gaps', () => {
  const byType = {
    id_photo: [{ side: 'front', expirationDate: '2030-01-01' }, { side: 'back', expirationDate: '2030-01-01' }],
    paystubs_30d: [stub('2026-06-29', '2026-07-28')],
    // One document missing several months is still one outstanding document.
    bank_2mo: [stmt('2026-01', { pagesPresent: 1, pagesTotal: 6 })],
    w2_2yr: [],
  }
  assert.deepEqual(documentReadiness(CHECKLIST, byType, at), { percent: 50, complete: 2, total: 4 })
})

test('an empty checklist is zero, not a crash or a perfect score', () => {
  assert.deepEqual(documentReadiness([], {}, at), { percent: 0, complete: 0, total: 0 })
  assert.deepEqual(missingForFile([], {}, at), [])
  assert.deepEqual(missingForFile(null, null, at), [])
})

// ── the catalog is the boundary ─────────────────────────────────────────────
test('every catalog entry is usable and keyed to itself', () => {
  for (const [key, type] of Object.entries(DOCUMENT_TYPES)) {
    assert.equal(type.key, key)
    assert.ok(type.label && type.hints.length && Array.isArray(type.extract))
    assert.equal(getDocumentType(key), type)
    assert.ok(isKnownDocumentType(key))
  }
  assert.equal(getDocumentType('invented_by_a_model'), null)
  assert.equal(isKnownDocumentType('invented_by_a_model'), false)
})

test('nothing the borrower is asked for reads as a conclusion about them', () => {
  // The boundary in one assertion: gap messages request documents. Words that characterize the
  // applicant or their loan belong to the reviewed, internal side.
  const forbidden = /\b(denied|declined|approved|qualif|ineligible|risk|score|dti|ltv|insufficient income)\b/i
  const samples = [
    assessCompleteness('bank_12mo', [stmt('2026-01'), stmt('2026-07')], at),
    assessCompleteness('id_photo', [{ side: 'front', expirationDate: '2020-01-01' }], at),
    assessCompleteness('paystubs_30d', [], at),
    assessCompleteness('hoi_dec', [{ policyStart: '2020-01-01', policyEnd: '2021-01-01' }], at),
  ]
  for (const s of samples) {
    for (const g of s.gaps) assert.doesNotMatch(g.message, forbidden, g.message)
  }
})
