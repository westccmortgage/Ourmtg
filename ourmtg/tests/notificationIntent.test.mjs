// Phase 1C — notification-INTENT mapping (no send). §12.
import test from 'node:test'
import assert from 'node:assert/strict'
import { notificationIntentFor, ACTION_INTENT } from '../netlify/functions/_lib/notificationIntent.mjs'

test('material borrower actions produce an intent; others do not', () => {
  assert.equal(notificationIntentFor('create', { taskId: 't', loanFileId: 'f' }).metadata.intent, 'borrower_task_created')
  assert.equal(notificationIntentFor('reject', { taskId: 't' }).metadata.intent, 'borrower_task_rejected')
  assert.equal(notificationIntentFor('requestMoreInfo', { taskId: 't' }).metadata.intent, 'borrower_task_more_information_needed')
  assert.equal(notificationIntentFor('assign', { taskId: 't' }), null) // internal, no borrower notice
  assert.equal(notificationIntentFor('accept', { taskId: 't' }), null)
})

test('intent metadata is minimal (no PII / financial detail) and event_type is queued', () => {
  const i = notificationIntentFor('create', { taskId: 't', loanFileId: 'f' })
  assert.equal(i.event_type, 'notification.queued')
  assert.deepEqual(Object.keys(i.metadata).sort(), ['intent', 'loan_file_id', 'recipient_role', 'task_id'])
  assert.equal(i.metadata.recipient_role, 'borrower')
})

test('ACTION_INTENT covers the required borrower notices', () => {
  for (const k of ['create', 'reject', 'requestMoreInfo', 'dueSoon']) assert.ok(ACTION_INTENT[k])
})
