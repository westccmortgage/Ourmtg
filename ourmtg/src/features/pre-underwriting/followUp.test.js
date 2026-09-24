// The one place in this product where software talks to a borrower unprompted.
//
// Two failure modes are worth more than the rest put together: saying something it is not
// allowed to say, and saying anything at all too often. These tests hold both lines.

import test from 'node:test'
import assert from 'node:assert/strict'
import { composeFollowUp } from './followUp.js'
import { buildFileTasks } from './fileTasks.js'

const AS_OF = Date.parse('2026-09-01T00:00:00Z')
const report = (over = {}) => ({
  openFields: [], structural: [], conflicts: [], totalRequired: 10, bySection: {}, ...over,
})

const fileWith = (over = {}) => buildFileTasks({
  report: report(over.report || {}),
  checklist: over.checklist || [],
  byType: over.byType || {},
  findings: over.findings || [],
  credit: over.credit ?? { authorized: true },
  asOf: AS_OF,
}).tasks

test('after a read that left a page missing, the ask names the page', () => {
  const tasks = fileWith({
    checklist: [{ docKey: 'bank_2mo' }],
    byType: {
      bank_2mo: [
        { statementMonth: '2026-07', statementEnd: '2026-07-31', pagesSeen: [1, 2, 3, 4, 5, 7], pagesTotal: 7, institutionName: 'Chase' },
        { statementMonth: '2026-08', statementEnd: '2026-08-31' },
      ],
    },
  })
  const out = composeFollowUp({ tasks, justRead: 'bank statement' })
  assert.equal(out.send, true)
  assert.match(out.body, /we have read your bank statement/i)
  assert.match(out.body, /pages 1–5 and 7/)
  assert.match(out.body, /Page 6 is still missing/)
})

test('nothing is sent twice', () => {
  // The whole reason a borrower stops reading these.
  const tasks = fileWith({ checklist: [{ docKey: 'paystubs_30d' }] })
  const first = composeFollowUp({ tasks, justRead: 'pay stub' })
  assert.equal(first.send, true)
  const again = composeFollowUp({ tasks, justRead: 'pay stub', lastMessage: first.body })
  assert.equal(again.send, false)
  assert.equal(again.reason, 'unchanged')
  assert.equal(again.body, null)
})

test('a message differing only in wrapping is the same message', () => {
  const tasks = fileWith({ checklist: [{ docKey: 'paystubs_30d' }] })
  const first = composeFollowUp({ tasks, justRead: 'pay stub' })
  const rewrapped = first.body.replace(/\n+/g, '  ')
  assert.equal(composeFollowUp({ tasks, justRead: 'pay stub', lastMessage: rewrapped }).send, false)
})

test('a finding cannot appear in a borrower message, because it is not in the input', () => {
  const tasks = fileWith({
    checklist: [{ docKey: 'paystubs_30d' }],
    findings: [
      { id: 'f1', rule: 'undisclosed_liability', status: 'pending_review', severity: 'high', category: 'liabilities', explanation: 'Discover shows a payment of $340 not on the application' },
      { id: 'f2', rule: 'income_consistency', status: 'pending_review', severity: 'high', category: 'income', explanation: 'Stated income exceeds the pay stub by 40%' },
    ],
  })
  const out = composeFollowUp({ tasks, justRead: 'pay stub' })
  for (const leak of ['Discover', '340', 'undisclosed', 'exceeds', '40%']) {
    assert.ok(!out.body.includes(leak), `follow-up leaked "${leak}"`)
  }
})

test('a message never promises, approves, or estimates', () => {
  const tasks = fileWith({
    report: { openFields: [{ path: 'parties[0].legalFirstName', section: 'identity' }] },
    checklist: [{ docKey: 'bank_2mo' }, { docKey: 'credit_report' }],
    credit: { authorized: false, reason: 'not_authorized' },
  })
  const out = composeFollowUp({ tasks, justRead: 'ID' })
  for (const forbidden of [/approv/i, /qualif/i, /pre-?qualif/i, /you should get/i, /likely/i, /rate/i, /denied/i]) {
    assert.ok(!forbidden.test(out.body), `follow-up used forbidden language: ${forbidden} — ${out.body}`)
  }
})

test('the borrower is never asked for something only the team can get', () => {
  const tasks = fileWith({ checklist: [{ docKey: 'credit_report' }] })
  const out = composeFollowUp({ tasks, justRead: 'pay stub' })
  // Nothing outstanding for THEM: the credit report is the team's to pull.
  assert.match(out.body, /everything we need from you/i)
  assert.ok(!/credit report/i.test(out.body), out.body)
})

test('“you are done” is only said in answer to something', () => {
  // Unprompted, it is noise. After an upload, it is the answer to the question they just asked
  // by uploading.
  const tasks = fileWith({})
  assert.equal(composeFollowUp({ tasks }).send, false)
  assert.equal(composeFollowUp({ tasks, justRead: 'pay stub' }).send, true)
})

test('a long list is truncated and says so, rather than running forever', () => {
  const openFields = Array.from({ length: 9 }, (_, i) => ({ path: `parties[0].field${i}`, section: 'identity' }))
  const tasks = fileWith({ report: { openFields } })
  const out = composeFollowUp({ tasks, justRead: 'ID' })
  assert.match(out.body, /9 things are still outstanding/)
  assert.match(out.body, /and 4 more on your checklist/)
  assert.ok(out.body.split('•').length - 1 === 5, out.body)
})

test('a read that failed says so without blaming anyone or guessing why', () => {
  const tasks = fileWith({ checklist: [{ docKey: 'bank_2mo' }] })
  const out = composeFollowUp({ tasks, justRead: 'bank statement', readFailed: true })
  assert.equal(out.send, true)
  assert.match(out.body, /could not read it/i)
  assert.match(out.body, /our team will take a look/i)
  // No cause invented: we genuinely do not know whether it was the scan or the reader.
  assert.ok(!/blurry|dark|corrupt|your phone/i.test(out.body), out.body)
})

test('resolving the last item changes the message, so it is sent', () => {
  const before = fileWith({ checklist: [{ docKey: 'paystubs_30d' }] })
  const first = composeFollowUp({ tasks: before, justRead: 'bank statement' })
  const after = fileWith({
    checklist: [{ docKey: 'paystubs_30d' }],
    byType: { paystubs_30d: [{ payPeriodStart: '2026-08-02', payPeriodEnd: '2026-08-31', periodEnd: '2026-08-31' }] },
  })
  const second = composeFollowUp({ tasks: after, justRead: 'pay stub', lastMessage: first.body })
  assert.equal(second.send, true)
  assert.match(second.body, /everything we need from you/i)
})
