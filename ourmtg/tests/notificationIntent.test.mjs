// Phase 1C — notification-INTENT mapping (no send). §12.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

// FCG-6.7: recording a notification intent CANNOT invoke a delivery provider. The intent path is
// pure data — no email/SMS/push/webhook is imported or called. Prove it structurally: neither the
// intent mapper nor the task repository (the two modules that produce/persist intents) reference any
// delivery provider or send primitive.
test('FCG-6.7: notification-intent path invokes no delivery provider (structural proof)', () => {
  const FORBIDDEN = [/mailer/i, /sendPlatformEmail/i, /resend/i, /twilio/i, /nodemailer/i, /sendgrid/i, /webhook/i, /\bfetch\s*\(/]
  for (const rel of ['../netlify/functions/_lib/notificationIntent.mjs', '../netlify/functions/_lib/taskRepo.mjs']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    for (const re of FORBIDDEN) assert.ok(!re.test(src), `${rel} must not reference a delivery provider (${re})`)
  }
  // And the mapper returns a data descriptor only — no function/callable to trigger a send.
  const i = notificationIntentFor('reject', { taskId: 't' })
  for (const v of Object.values(i)) assert.notEqual(typeof v, 'function')
})
