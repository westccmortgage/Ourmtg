// The one list both screens read from.
//
// The bug class these exist to kill: a borrower told "all done" while the processor's panel
// shows two outstanding items. That happened because the checklist and the 1003 each computed
// "what's left" from their own half. These tests assert the two views are PROJECTIONS of one
// array, and — more importantly — that the borrower's projection is structurally incapable of
// carrying anything from the internal side.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFileTasks, borrowerView, teamView, nextBorrowerAction,
  OPERATIONAL_SECTIONS, DOCUMENT_SECTION,
} from './fileTasks.js'

const AS_OF = Date.parse('2026-09-01T00:00:00Z')

const report = (over = {}) => ({
  openFields: [], structural: [], conflicts: [], totalRequired: 10, bySection: {}, ...over,
})
const CHECKLIST = [
  { docKey: 'id_photo' }, { docKey: 'paystubs_30d' }, { docKey: 'bank_2mo' }, { docKey: 'credit_report' },
]

test('an empty file produces tasks for everything and nothing crashes', () => {
  const { tasks, operational } = buildFileTasks({ checklist: CHECKLIST, asOf: AS_OF })
  assert.ok(tasks.length >= 4)
  assert.equal(operational.complete, false)
  assert.ok(operational.percent < 50)
})

test('the borrower and the team never disagree about what is outstanding', () => {
  // The invariant: every borrower task is also a team task. Two projections, one array — if
  // this ever fails the screens are computing rather than rendering.
  const { tasks } = buildFileTasks({
    report: report({
      openFields: [{ path: 'parties[0].legalFirstName', section: 'identity' }],
      conflicts: [{ path: 'parties[0].income[0].amount', section: 'income' }],
    }),
    checklist: CHECKLIST,
    byType: {},
    findings: [{ id: 'f1', rule: 'income_consistency', status: 'pending_review', severity: 'high', category: 'income', explanation: 'periods differ' }],
    credit: { authorized: false, reason: 'not_authorized' },
    asOf: AS_OF,
  })
  const mine = borrowerView(tasks)
  const theirs = teamView(tasks)
  for (const b of mine) {
    assert.ok(theirs.some((t) => t.id === b.id), `team view is missing borrower task ${b.id}`)
  }
  assert.ok(theirs.length > mine.length, 'the team sees strictly more')
})

test('a finding can never reach the borrower, by construction', () => {
  // Not "the screen does not render it" — the projection cannot emit it. human_review is never
  // borrower-owned, and borrowerView filters on both.
  const { tasks } = buildFileTasks({
    report: report(),
    checklist: [],
    findings: [
      { id: 'f1', rule: 'undisclosed_liability', status: 'pending_review', severity: 'high', category: 'liabilities', explanation: 'Discover shows a payment of $340 not on the application' },
      { id: 'f2', rule: 'large_deposit', status: 'pending_review', severity: 'medium', category: 'assets', explanation: 'A deposit of $18,500 needs sourcing' },
    ],
    asOf: AS_OF,
  })
  const serialized = JSON.stringify(borrowerView(tasks))
  for (const leak of ['Discover', '18,500', 'undisclosed', 'large_deposit', 'sourcing']) {
    assert.ok(!serialized.includes(leak), `borrower view leaked "${leak}"`)
  }
  assert.equal(borrowerView(tasks).length, 0)
  assert.equal(teamView(tasks).filter((t) => t.kind === 'human_review').length, 2)
})

test('the borrower never sees a dotted field path', () => {
  // `parties[0].legalFirstName` is a developer's name for a question. The catalog has the
  // borrower's name for it, and that is what a task carries.
  const { tasks } = buildFileTasks({
    report: report({ openFields: [{ path: 'parties[0].legalFirstName', section: 'identity' }] }),
    asOf: AS_OF,
  })
  const t = borrowerView(tasks)[0]
  assert.ok(t.title.length > 0)
  assert.ok(!/parties\[|\./.test(t.title), `raw path leaked: ${t.title}`)
})

test('a structural gap becomes a sentence, not an engine keyword', () => {
  const { tasks } = buildFileTasks({
    report: report({
      structural: [
        { kind: 'min_records', group: 'employment', partyIndex: 0, have: 0, need: 1 },
        { kind: 'history_gap', group: 'residence', partyIndex: 0 },
      ],
    }),
    asOf: AS_OF,
  })
  const titles = borrowerView(tasks).map((t) => t.title).join(' | ')
  assert.ok(!/min_records|history_gap|history_backfill/.test(titles), titles)
  assert.match(titles, /employment/i)
  assert.match(titles, /gap in your address history/i)
})

test('documents the borrower cannot obtain are the team’s task, not theirs', () => {
  const { tasks } = buildFileTasks({ checklist: CHECKLIST, byType: {}, asOf: AS_OF })
  const credit = tasks.find((t) => t.docKey === 'credit_report')
  assert.equal(credit.owner, 'loan_team')
  assert.ok(!borrowerView(tasks).some((t) => t.docKey === 'credit_report'))
  // …while the pay stubs are squarely theirs.
  assert.equal(tasks.find((t) => t.docKey === 'paystubs_30d').owner, 'borrower')
})

test('a document task carries the request sentences verbatim', () => {
  // completeness.js already phrases every gap as something to send; re-writing them here would
  // be a second voice for the same fact.
  const { tasks } = buildFileTasks({
    checklist: [{ docKey: 'id_photo' }],
    byType: { id_photo: [{ side: 'front', expirationDate: '2031-01-01' }] },
    asOf: AS_OF,
  })
  const t = borrowerView(tasks)[0]
  assert.equal(t.docKey, 'id_photo')
  assert.ok(t.requests.length > 0)
  assert.match(t.requests.join(' '), /back/i)
})

test('the next action is the cheapest useful one, and documents come first', () => {
  const { tasks } = buildFileTasks({
    report: report({ openFields: [{ path: 'parties[0].legalFirstName', section: 'identity' }] }),
    checklist: [{ docKey: 'paystubs_30d' }],
    byType: {},
    credit: { authorized: false, reason: 'not_authorized' },
    asOf: AS_OF,
  })
  // A document is one tap from a phone and unblocks the analysis everything else depends on.
  assert.equal(nextBorrowerAction(tasks).kind, 'document')

  const noDocs = buildFileTasks({
    report: report({ conflicts: [{ path: 'loan.purpose', section: 'loan' }] }),
    checklist: [], asOf: AS_OF,
  })
  assert.equal(nextBorrowerAction(noDocs.tasks).kind, 'application_conflict')
  assert.equal(nextBorrowerAction(buildFileTasks({ checklist: [], asOf: AS_OF }).tasks), null)
})

// ── the number ──────────────────────────────────────────────────────────────

test('operational readiness states what it is not, every time', () => {
  const { operational } = buildFileTasks({ report: report(), checklist: CHECKLIST, asOf: AS_OF })
  for (const phrase of ['approval', 'probability', 'credit decision', 'underwriting']) {
    assert.ok(operational.notMeaning.some((n) => n.includes(phrase)), phrase)
  }
  assert.match(operational.meaning, /present and free of open questions/)
})

test('human review does not hold a file back from being operationally complete', () => {
  // A processor's opinion is not something the FILE is missing. Counting it would mean no file
  // could ever be complete while somebody still has a judgement to form.
  const { operational } = buildFileTasks({
    report: report({ totalRequired: 0 }),
    checklist: [],
    credit: { authorized: true },
    findings: [{ id: 'f1', rule: 'r', status: 'pending_review', severity: 'low', category: 'income', explanation: 'look at this' }],
    asOf: AS_OF,
  })
  assert.equal(operational.complete, true)
  assert.equal(operational.humanReview, 1)
})

test('outstanding work is attributed to the side that can actually do it', () => {
  const { operational } = buildFileTasks({
    report: report({ openFields: [{ path: 'parties[0].legalFirstName', section: 'identity' }] }),
    checklist: [{ docKey: 'credit_report' }, { docKey: 'paystubs_30d' }],
    byType: {},
    credit: { authorized: true },
    asOf: AS_OF,
  })
  assert.equal(operational.teamOutstanding, 1)      // the credit report
  assert.equal(operational.borrowerOutstanding, 2)  // the name + the pay stubs
})

// ── sections ────────────────────────────────────────────────────────────────

test('sections roll up to one word a processor can scan', () => {
  const { sections } = buildFileTasks({
    report: report({
      openFields: [{ path: 'parties[0].income[0].amount', section: 'income' }],
      bySection: { identity: { required: 3 }, income: { required: 4 } },
    }),
    checklist: CHECKLIST,
    byType: {
      id_photo: [{ side: 'front', expirationDate: '2031-01-01' }, { side: 'back', expirationDate: '2031-01-01' }],
    },
    credit: { authorized: true },
    asOf: AS_OF,
  })
  const by = Object.fromEntries(sections.map((s) => [s.key, s]))
  assert.equal(by.identity.state, 'complete', JSON.stringify(by.identity))
  assert.equal(by.income.state, 'needs_attention')
  assert.ok(by.income.open >= 1)
  for (const s of sections) assert.ok(OPERATIONAL_SECTIONS.includes(s.key))
})

test('a section that only has human review reads as in review, not as broken', () => {
  const { sections } = buildFileTasks({
    report: report({ bySection: { income: { required: 2 } } }),
    checklist: [],
    findings: [{ id: 'f1', rule: 'r', status: 'pending_review', severity: 'low', category: 'income', explanation: 'x' }],
    credit: { authorized: true },
    asOf: AS_OF,
  })
  assert.equal(sections.find((s) => s.key === 'income').state, 'in_review')
})

test('a resolved finding stops appearing as work', () => {
  const { tasks } = buildFileTasks({
    report: report(), checklist: [], credit: { authorized: true },
    findings: [{ id: 'f1', rule: 'r', status: 'dismissed', severity: 'low', category: 'income', explanation: 'x' }],
    asOf: AS_OF,
  })
  assert.equal(tasks.filter((t) => t.kind === 'human_review').length, 0)
})

test('unread uploads are named rather than silently counted as done', () => {
  const { tasks } = buildFileTasks({
    report: report(), checklist: [], credit: { authorized: true },
    unread: [{ id: 'd1', docKey: 'bank_2mo' }, { id: 'd2', docKey: 'w2_2yr' }],
    asOf: AS_OF,
  })
  const t = tasks.find((x) => x.id === 'unread_documents')
  assert.ok(t)
  assert.equal(t.owner, 'loan_team')
  assert.match(t.title, /2 uploaded/)
  assert.ok(!borrowerView(tasks).some((x) => x.id === 'unread_documents'))
})

test('every catalogued document has a section, so nothing lands in a bucket named “other”', () => {
  for (const key of ['id_photo', 'paystubs_30d', 'bank_2mo', 'credit_report', 'purchase_contract', 'w2_2yr']) {
    assert.ok(DOCUMENT_SECTION[key], key)
    assert.ok(OPERATIONAL_SECTIONS.includes(DOCUMENT_SECTION[key]), key)
  }
})
