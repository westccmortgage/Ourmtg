// Credit liabilities → the 1003. The failure modes here are all quiet ones: a debt imported
// twice, a closed card inflating the DTI, a deferred loan dropped as "free", a borrower told
// they failed to disclose a debt they typed in themselves. Each test below is one of those.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inferLiabilityType, reportable, reconcile, planLiabilityImport, declaredLiabilities,
} from './creditImport.js'
import { undisclosedLiabilities } from './rules.js'
import { getField, isKnownField } from '../conversational-1003/applicationCatalog.js'
import { normalizeByType } from '../conversational-1003/normalization.js'

const tl = (over = {}) => ({
  creditorName: 'Chase Card Services', accountType: 'Revolving', accountLast4: '4412',
  monthlyPayment: 185, balance: 4210, status: 'Open', confidence: 0.95, ...over,
})

// ── classification ──────────────────────────────────────────────────────────

test('vendor wording maps into the catalog vocabulary, conservatively', () => {
  assert.equal(inferLiabilityType(tl()), 'revolving')
  assert.equal(inferLiabilityType(tl({ accountType: 'Installment', creditorName: 'Toyota Financial' })), 'installment')
  assert.equal(inferLiabilityType(tl({ accountType: 'Mortgage' })), 'mortgage')
  assert.equal(inferLiabilityType(tl({ accountType: 'Home Equity Line' })), 'heloc')
  assert.equal(inferLiabilityType(tl({ accountType: 'EDUCATION', creditorName: 'Navient' })), 'installment')
  // Unrecognized becomes 'other', never a guess — a wrong type changes how the debt is treated.
  assert.equal(inferLiabilityType(tl({ accountType: 'Mystery Product', creditorName: 'Acme' })), 'other')
})

// ── what belongs on a 1003 ──────────────────────────────────────────────────

test('a closed account with no balance is history, not a liability', () => {
  const r = reportable(tl({ status: 'Closed - Paid', balance: 0, monthlyPayment: 0 }))
  assert.equal(r.reportable, false)
})

test('a deferred loan with $0 payment and a real balance is imported AND flagged', () => {
  // The trap: dropping it makes a $60k student loan cost nothing. The agencies impute a payment.
  const r = reportable(tl({ monthlyPayment: 0, balance: 60000, accountType: 'Education' }))
  assert.equal(r.reportable, true)
  assert.equal(r.needsPayment, true)
})

test('a charged-off account with a remaining balance still surfaces', () => {
  const r = reportable(tl({ status: 'Charge-off', balance: 900, monthlyPayment: 0 }))
  assert.equal(r.reportable, true)
})

// ── reconciliation ──────────────────────────────────────────────────────────

test('a declared debt is matched, not re-imported and not called undisclosed', () => {
  const { matched, onlyOnCredit } = reconcile(
    [tl()],
    [{ creditorName: 'Chase', accountLast4: '4412', monthlyPayment: 185 }],
  )
  assert.equal(matched.length, 1)
  assert.equal(onlyOnCredit.length, 0)
})

test('matching works on the creditor name alone when no account number was given', () => {
  // "Chase Card Services" on the report, "chase card" typed by the borrower. Demanding equality
  // would report everything as new and the feature becomes noise.
  const { matched } = reconcile([tl({ accountLast4: null })], [{ creditorName: 'CHASE CARD' }])
  assert.equal(matched.length, 1)
})

test('a matched pair that disagrees on the payment says so with both numbers', () => {
  const { matched } = reconcile([tl({ monthlyPayment: 320 })], [{ creditorName: 'Chase Card', monthlyPayment: 120 }])
  assert.equal(matched.length, 1)
  assert.deepEqual(matched[0].differs, [{ field: 'monthlyPayment', credit: 320, application: 120 }])
})

test('debts only on the application are reported, not treated as an error', () => {
  // Family loans and support obligations are routinely absent from a credit report and still count.
  const { onlyOnApplication } = reconcile([tl()], [
    { creditorName: 'Chase Card', accountLast4: '4412' },
    { creditorName: 'Family loan from brother', monthlyPayment: 400 },
  ])
  assert.equal(onlyOnApplication.length, 1)
  assert.equal(onlyOnApplication[0].creditorName, 'Family loan from brother')
})

// ── the import plan ─────────────────────────────────────────────────────────

test('the plan writes every 1003 field the catalog requires, at the next free index', () => {
  const { writes, imported } = planLiabilityImport({
    tradelines: [tl({ creditorName: 'Discover', accountLast4: '9001' })],
    declared: [], partyIndex: 0, nextIndex: 2,
  })
  const paths = writes.map((w) => w.path)
  assert.ok(paths.includes('parties[0].hasAnyLiabilities'))
  assert.ok(paths.includes('parties[0].liabilities[2].creditorName'))
  assert.ok(paths.includes('parties[0].liabilities[2].liabilityType'))
  assert.ok(paths.includes('parties[0].liabilities[2].monthlyPayment'))
  assert.ok(paths.includes('parties[0].liabilities[2].unpaidBalance'))
  assert.equal(imported.length, 1)
})

test('every planned write lands on a real catalog field and survives its own normalization', () => {
  // The whole point of writing through the reducer is that the catalog validates; a plan that
  // produces an unknown path or an unnormalizable value would fail at exactly the wrong moment.
  const { writes } = planLiabilityImport({
    tradelines: [tl(), tl({ creditorName: 'Navient', accountType: 'Education', monthlyPayment: 0, balance: 61000, accountLast4: '7001' })],
    declared: [],
  })
  for (const w of writes) {
    assert.ok(isKnownField(w.path), w.path)
    const field = getField(w.path)
    assert.ok(!field.secureEntry, `${w.path} must not be a secure field`)
    const norm = normalizeByType(field.type, w.value, field)
    assert.equal(norm.ok, true, `${w.path} = ${w.value}: ${norm.reason || ''}`)
  }
})

test('the account number is never in the plan, even when the report had one', () => {
  const { writes } = planLiabilityImport({ tradelines: [tl()], declared: [] })
  assert.ok(!writes.some((w) => /accountNumber/.test(w.path)))
  assert.ok(!JSON.stringify(writes).includes('4412'))
})

test('a zero payment is written as zero and flagged, never omitted', () => {
  const { writes, needsPayment } = planLiabilityImport({
    tradelines: [tl({ monthlyPayment: 0, balance: 61000, accountType: 'Education', accountLast4: '7001' })],
    declared: [],
  })
  const pay = writes.find((w) => /monthlyPayment/.test(w.path))
  assert.equal(pay.value, 0)
  assert.equal(needsPayment.length, 1)
  assert.match(needsPayment[0].why, /payment to be established/)
})

test('already-declared and closed accounts do not reach the plan', () => {
  const { writes, imported, skipped } = planLiabilityImport({
    tradelines: [
      tl(),                                                          // declared below
      tl({ creditorName: 'Old Navy Card', accountLast4: '1111', status: 'Closed - paid', balance: 0, monthlyPayment: 0 }),
      tl({ creditorName: 'Discover', accountLast4: '9001' }),        // genuinely new
    ],
    declared: [{ creditorName: 'Chase Card', accountLast4: '4412' }],
  })
  assert.equal(imported.length, 1)
  assert.equal(imported[0].creditorName, 'Discover')
  assert.equal(skipped.length, 1)
  assert.ok(!writes.some((w) => String(w.value).includes('Old Navy')))
})

test('an empty report plans nothing, including the yes/no gate', () => {
  const { writes } = planLiabilityImport({ tradelines: [], declared: [] })
  assert.deepEqual(writes, [])
})

// ── reading what the application already says ───────────────────────────────

const stateRow = (path, value) => ({ field_path: path, normalized_value: { value } })

test('declaredLiabilities reassembles rows from the field-state projection', () => {
  const rows = declaredLiabilities([
    stateRow('parties[0].liabilities[0].creditorName', 'Chase'),
    stateRow('parties[0].liabilities[0].monthlyPayment', 185),
    stateRow('parties[0].liabilities[1].creditorName', 'Toyota Financial'),
    stateRow('parties[0].liabilities[1].unpaidBalance', 18400),
    stateRow('parties[0].income.amount', 9000),          // not a liability
    stateRow('parties[1].liabilities[0].creditorName', 'Not this party'),
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].creditorName, 'Chase')
  assert.equal(rows[0].monthlyPayment, 185)
  assert.equal(rows[1].unpaidBalance, 18400)
})

test('a half-entered row with no creditor is not offered for matching', () => {
  const rows = declaredLiabilities([stateRow('parties[0].liabilities[0].monthlyPayment', 99)])
  assert.deepEqual(rows, [])
})

// ── the loop closes ─────────────────────────────────────────────────────────

test('after an import, undisclosed_liability stops firing for what was imported', () => {
  // The full circle: report read → finding raised → imported into the 1003 → finding gone.
  const tradelines = [tl({ creditorName: 'Discover', accountLast4: '9001', monthlyPayment: 320 })]

  const before = undisclosedLiabilities({ creditLiabilities: tradelines, application: { liabilities: [] } })
  assert.equal(before.length, 1, 'fires while undeclared')

  const { imported } = planLiabilityImport({ tradelines, declared: [] })
  const after = undisclosedLiabilities({
    creditLiabilities: tradelines,
    application: { liabilities: imported.map((i) => ({ creditorName: i.creditorName })) },
  })
  assert.deepEqual(after, [], 'stops firing once the 1003 knows about it')
})

test('the stub this replaces was reporting every declared debt as undisclosed', () => {
  // Regression for the panel bug: applicationFacts returned liabilities: [] unconditionally, so
  // a borrower who declared everything still produced one high-severity finding per tradeline.
  const declared = declaredLiabilities([
    stateRow('parties[0].liabilities[0].creditorName', 'Chase Card'),
  ])
  const findings = undisclosedLiabilities({
    creditLiabilities: [tl()],
    application: { liabilities: declared },
  })
  assert.deepEqual(findings, [])
})
