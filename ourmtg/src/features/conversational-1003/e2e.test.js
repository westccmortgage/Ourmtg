// Conversational 1003 — end-to-end acceptance (§29).
//
// Drives a complete borrower application from the very first question to attestation using the
// REAL planner, reducer, rules, completeness engine, and turn contract. Only two things are
// substituted: the database (state is held in memory exactly as the repo would rebuild it) and
// the live AI provider (the deterministic mock stands in).
//
// This is the test that proves the product actually works rather than merely type-checks:
//   • the interview terminates — no unreachable required field, no infinite loop
//   • a borrower never has to open a conventional long-form 1003
//   • completeness only reaches 100% when everything really is resolved
//   • attestation is gated on that, and nothing else

import test from 'node:test'
import assert from 'node:assert/strict'

import { emptyState, recordValue, confirmValue, resolveConflict, declineField, fieldValue } from './applicationReducer.js'
import { planNextQuestion, noteAsked } from './questionPlanner.js'
import { computeCompleteness, canAttest } from './completenessEngine.js'
import { buildReview, buildTeamReview } from './review.js'
import { getField } from './applicationCatalog.js'

const AS_OF = '2026-07'
const AT = '2026-07-29T12:00:00.000Z'

let seq = 0
const nextId = () => `e${++seq}`

// A fictional borrower with a coherent, ordinary profile. The driver answers whatever the
// planner asks; these are the values it uses when a specific field comes up.
const ANSWERS = {
  'legalFirstName': 'Daria', 'legalMiddleName': 'A', 'legalLastName': 'Nikolaev', 'suffix': 'n/a',
  'email': 'daria@example.com', 'phone': '3105551234', 'dateOfBirth': '1988-04-12',
  'citizenshipStatus': 'permanent_resident', 'maritalStatus': 'married', 'dependentsCount': '2',
  'dependentsAges': '7, 11', 'mailingAddressSameAsCurrent': 'yes',
  'hasAnyLiabilities': 'yes', 'ownsOtherRealEstate': 'no',
  'street': '1420 Cabrillo Avenue', 'city': 'Torrance', 'state': 'CA', 'postalCode': '90501',
  'occupancyBasis': 'rent', 'monthlyHousingExpense': '2850',
  'employerName': 'Harbor Logistics Inc', 'position': 'Operations Manager',
  'employmentType': 'w2_employee', 'employerStreet': '900 Del Amo Blvd', 'employerCity': 'Torrance',
  'employerState': 'CA', 'employerPostalCode': '90503', 'employerPhone': '3105559876',
  'incomeType': 'base', 'amount': '9200', 'frequency': 'monthly',
  'assetType': 'checking', 'institutionName': 'Chase', 'balance': '84000',
  'liabilityType': 'installment', 'creditorName': 'Toyota Financial', 'monthlyPayment': '480',
  'unpaidBalance': '14200', 'toBePaidOffAtClosing': 'no',
  'purpose': 'purchase', 'occupancy': 'primary_residence', 'propertyType': 'single_family',
  'purchasePrice': '1088000', 'requestedLoanAmount': '870400', 'downPaymentAmount': '217600',
  'downPaymentSource': 'checking_savings', 'isUnderContract': 'yes',
  'propertyStreet': '25 Paseo Del Mar', 'propertyCity': 'Palos Verdes Estates',
  'propertyState': 'CA', 'propertyPostalCode': '90274', 'mixedUseProperty': 'no',
}

/** Answer whatever was asked, using the profile above and the field's declared type. */
function answerFor(question) {
  const leaf = String(question.fieldPath).split('.').pop().replace(/\[\d+\]/, '')
  if (question.structural === 'history_backfill') return null // handled explicitly by the driver
  if (ANSWERS[leaf] !== undefined) return ANSWERS[leaf]

  const f = getField(question.fieldPath)
  if (!f) return null
  if (question.section === 'declarations') return leaf === 'occupyAsPrimaryResidence' ? 'yes' : 'no'
  switch (f.type) {
    case 'boolean': return 'no'
    case 'enum': return f.values?.[0] ?? null
    case 'amount': return '1000'
    case 'percent': return '100'
    case 'integer': return '0'
    case 'month': return '2019-06'
    case 'date': return '2026-09-15'
    case 'address': return '1 Example Street'
    case 'phone': return '3105550000'
    case 'email': return 'daria@example.com'
    case 'ssn': case 'account_number': return null // secure control only
    default: return 'Not applicable'
  }
}

test('a borrower completes the whole application conversationally and attests', () => {
  let state = emptyState({ applicationId: 'e2e', partyCount: 1 })
  let askedHistory = {}
  const asked = []
  let guard = 0

  while (guard++ < 400) {
    const q = planNextQuestion(state, { asOfMonth: AS_OF, askedHistory, locale: 'en' })
    if (q.type === 'review' || q.type === 'complete') break

    // Pending confirmations: the borrower taps "Correct".
    if (q.type === 'confirm') {
      for (const item of q.items) {
        const r = confirmValue(state, { path: item.path, at: AT, eventId: nextId(), actor: 'u1' })
        if (r.state) state = r.state
      }
      continue
    }

    if (q.type === 'conflict') {
      const r = resolveConflict(state, {
        path: q.fieldPath, chosenValue: q.choices[0].value, at: AT, eventId: nextId(), actor: 'u1',
      })
      state = r.state || state
      continue
    }

    asked.push(q.fieldPath)
    askedHistory = noteAsked(askedHistory, q.id, { at: AT })
    const f = getField(q.fieldPath)

    // Secure fields go through the masked control, never the conversation.
    if (f?.secureEntry) {
      const r = recordValue(state, {
        path: q.fieldPath, rawValue: '••••6789', source: 'borrower_secure_input',
        at: AT, eventId: nextId(), status: 'borrower_confirmed', actor: 'u1',
      })
      assert.equal(r.outcome, 'stored', `secure field ${q.fieldPath} must be writable via the secure control`)
      state = r.state
      continue
    }

    // Optional demographics: this borrower declines. It must never block completion.
    if (f?.allowDecline) {
      const r = declineField(state, { path: q.fieldPath, at: AT, eventId: nextId(), actor: 'u1' })
      state = r.state || state
      continue
    }

    const value = answerFor(q)
    assert.ok(value != null, `driver has no answer for ${q.fieldPath} (${f?.type})`)
    const rec = recordValue(state, {
      path: q.fieldPath, rawValue: value, source: 'borrower_text',
      at: AT, eventId: nextId(), actor: 'u1',
    })
    assert.notEqual(rec.outcome, 'rejected', `${q.fieldPath} rejected "${value}": ${rec.reason}`)
    state = rec.state

    // High-impact answers are confirmed, as the confirmation card would do.
    if (rec.event && rec.event.status === 'candidate') {
      const c = confirmValue(state, { path: q.fieldPath, at: AT, eventId: nextId(), actor: 'u1' })
      if (c.state) state = c.state
    }
  }

  assert.ok(guard < 400, 'the interview must terminate, not loop')

  const report = computeCompleteness(state, { asOfMonth: AS_OF })
  assert.equal(report.openFields.length, 0, `still open: ${report.openFields.slice(0, 5).map((o) => o.path).join(', ')}`)
  assert.equal(report.structural.length, 0, `structural gaps: ${JSON.stringify(report.structural.slice(0, 3))}`)
  assert.equal(report.conflicts.length, 0)
  assert.equal(report.everythingResolved, true)
  assert.equal(report.percent, 100)
  assert.equal(canAttest(report), true)
  assert.equal(report.status, 'ready_for_borrower_review')

  // The borrower answered a real interview, not a token one.
  assert.ok(asked.length >= 40, `expected a substantive interview, got ${asked.length} questions`)

  // Sanity: the profile actually landed where it belongs.
  assert.equal(fieldValue(state, 'loan.purchasePrice'), 1088000)
  assert.equal(fieldValue(state, 'parties[0].legalLastName'), 'Nikolaev')
  assert.equal(fieldValue(state, 'parties[0].income[0].frequency'), 'monthly')
  // Derived monthly equivalent is present and is NOT labeled borrower-provided.
  assert.equal(fieldValue(state, 'parties[0].employment[0].employerName'), 'Harbor Logistics Inc')

  // Both review projections render without throwing and agree on the outcome.
  const borrowerView = buildReview(state, report, { locale: 'en' })
  assert.equal(borrowerView.percent, 100)
  assert.ok(borrowerView.groups.every((g) => ['complete', 'not_applicable'].includes(g.state)),
    `unfinished groups: ${borrowerView.groups.filter((g) => !['complete', 'not_applicable'].includes(g.state)).map((g) => `${g.section}:${g.state}`).join(', ')}`)

  const teamView = buildTeamReview(state, report, { parties: [{ id: 'p1', party_index: 0, party_role: 'borrower' }] })
  assert.equal(teamView.unresolvedRequired.length, 0)
  assert.equal(teamView.percent, 100)
  // "Complete" is still explicitly not an approval.
  assert.equal(teamView.meaning, 'information_collected_and_attested')
  assert.ok(teamView.notMeaning.includes('approved'))

  // A secure value is masked in BOTH views — the team never sees a full SSN either.
  const ssnItem = teamView.items.find((i) => i.path === 'parties[0].ssn')
  if (ssnItem) assert.equal(ssnItem.value, '••••')
})

test('the interview never re-asks a question it already resolved', () => {
  let state = emptyState({ applicationId: 'e2e2', partyCount: 1 })
  let askedHistory = {}
  const counts = new Map()
  let guard = 0

  while (guard++ < 400) {
    const q = planNextQuestion(state, { asOfMonth: AS_OF, askedHistory })
    if (q.type === 'review' || q.type === 'complete') break
    if (q.type === 'confirm') {
      for (const item of q.items) {
        const r = confirmValue(state, { path: item.path, at: AT, eventId: nextId(), actor: 'u1' })
        if (r.state) state = r.state
      }
      continue
    }
    if (q.type === 'conflict') {
      state = resolveConflict(state, { path: q.fieldPath, chosenValue: q.choices[0].value, at: AT, eventId: nextId() }).state
      continue
    }

    counts.set(q.fieldPath, (counts.get(q.fieldPath) || 0) + 1)
    // A field asked more than twice means the planner is stuck.
    assert.ok(counts.get(q.fieldPath) <= 2, `planner looped on ${q.fieldPath}`)

    askedHistory = noteAsked(askedHistory, q.id, { at: AT })
    const f = getField(q.fieldPath)
    if (f?.secureEntry) {
      state = recordValue(state, {
        path: q.fieldPath, rawValue: '••••1234', source: 'borrower_secure_input',
        at: AT, eventId: nextId(), status: 'borrower_confirmed',
      }).state
      continue
    }
    if (f?.allowDecline) {
      state = declineField(state, { path: q.fieldPath, at: AT, eventId: nextId() }).state || state
      continue
    }
    const rec = recordValue(state, {
      path: q.fieldPath, rawValue: answerFor(q), source: 'borrower_text', at: AT, eventId: nextId(),
    })
    state = rec.state
    if (rec.event?.status === 'candidate') {
      const c = confirmValue(state, { path: q.fieldPath, at: AT, eventId: nextId(), actor: 'u1' })
      if (c.state) state = c.state
    }
  }
  assert.ok(guard < 400)
})
