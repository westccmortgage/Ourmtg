// Notification event-model tests (Phase 1B §11).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotification, transitionNotification, isAllowedNotificationEvent } from '../src/domain/services/notifications.js'

test('builds a valid transactional notification with a portal link', () => {
  const r = buildNotification({ event: 'document_rejected', channel: 'email', recipientRole: 'borrower', language: 'es', portalLink: 'https://ourmtg.com/portal' })
  assert.equal(r.ok, true)
  assert.equal(r.notification.status, 'created')
  assert.equal(r.notification.portal_link, 'https://ourmtg.com/portal')
  assert.equal(r.notification.language, 'es')
})

test('rejects unknown events, bad channel/role/language', () => {
  assert.equal(buildNotification({ event: 'buy_now', channel: 'email', recipientRole: 'borrower' }).error, 'unknown_event')
  assert.equal(buildNotification({ event: 'funded', channel: 'fax', recipientRole: 'borrower' }).error, 'invalid_channel')
  assert.equal(buildNotification({ event: 'funded', channel: 'sms', recipientRole: 'stranger' }).error, 'invalid_recipient')
  assert.equal(buildNotification({ event: 'funded', channel: 'sms', recipientRole: 'borrower', language: 'zh' }).error, 'invalid_language')
})

test('NEVER allows financial-document attachments (portal links only)', () => {
  assert.equal(buildNotification({ event: 'funded', channel: 'email', recipientRole: 'borrower', attachment: 'w2.pdf' }).error, 'attachments_forbidden')
})

test('only transactional events are allowed', () => {
  assert.equal(isAllowedNotificationEvent('clear_to_close'), true)
  assert.equal(isAllowedNotificationEvent('promo_sale'), false)
})

test('delivery lifecycle: created→sent→delivered→opened→clicked; no skipping', () => {
  let n = buildNotification({ event: 'stage_changed', channel: 'email', recipientRole: 'borrower' }).notification
  n = transitionNotification(n, 'sent', { providerMessageId: 'pm1' }).notification
  assert.equal(n.provider_message_id, 'pm1')
  assert.equal(transitionNotification(n, 'clicked').error, 'invalid_transition') // can't skip delivered/opened
  n = transitionNotification(n, 'delivered').notification
  n = transitionNotification(n, 'opened').notification
  assert.equal(transitionNotification(n, 'clicked').ok, true)
})
