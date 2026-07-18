// Phase 1B — provider-neutral NOTIFICATION EVENT model (FLAG-GATED: flags.notificationEvents,
// OFF). This is NOT a campaign engine and sends nothing. It defines the event → notification
// record shape and a small delivery lifecycle. Rules: no marketing messages; NEVER attach
// financial documents to email — secure portal links only. Pure, no I/O.

import { NOTIFICATION_EVENT, NOTIFICATION_STATUS } from '../lifecycles.js'

const RECIPIENT_ROLES = new Set(['borrower', 'coborrower', 'realtor', 'loan_team'])
const CHANNELS = new Set(['email', 'sms'])
const LANGS = new Set(['en', 'es', 'ru'])

// Which events are transactional (allowed). Marketing/promotional events are not modeled here.
export function isAllowedNotificationEvent(event) {
  return NOTIFICATION_EVENT.includes(event)
}

// Build a notification RECORD (status 'created'). Does not send. Enforces: known event,
// portal-link-only (no attachments), valid channel/role/language.
export function buildNotification(input = {}) {
  const { event, channel, recipientRole, language = 'en', templateKey, portalLink } = input
  if (!isAllowedNotificationEvent(event)) return { ok: false, error: 'unknown_event' }
  if (!CHANNELS.has(channel)) return { ok: false, error: 'invalid_channel' }
  if (!RECIPIENT_ROLES.has(recipientRole)) return { ok: false, error: 'invalid_recipient' }
  if (!LANGS.has(language)) return { ok: false, error: 'invalid_language' }
  if (input.attachment || input.attachments) return { ok: false, error: 'attachments_forbidden' } // never attach financial docs
  const record = {
    event,
    channel,
    recipient_role: recipientRole,
    language,
    template_key: templateKey || `notif.${event}`,
    portal_link: portalLink || null, // secure portal link only
    status: 'created',
    provider_message_id: null,
    created_at: input.at ?? null,
    sent_at: null, delivered_at: null, opened_at: null, clicked_at: null, failed_at: null, suppressed_at: null,
  }
  return { ok: true, notification: record }
}

const NOTIF_TRANSITIONS = Object.freeze({
  created: ['sent', 'suppressed', 'failed'],
  sent: ['delivered', 'failed'],
  delivered: ['opened', 'failed'],
  opened: ['clicked'],
  clicked: [],
  failed: [],
  suppressed: [],
})

export function transitionNotification(n, toStatus, opts = {}) {
  if (!n || typeof n !== 'object') return { ok: false, error: 'no_notification' }
  if (!NOTIFICATION_STATUS.includes(toStatus)) return { ok: false, error: 'unknown_status' }
  if (!(NOTIF_TRANSITIONS[n.status] || []).includes(toStatus)) return { ok: false, error: 'invalid_transition' }
  const stamp = { sent: 'sent_at', delivered: 'delivered_at', opened: 'opened_at', clicked: 'clicked_at', failed: 'failed_at', suppressed: 'suppressed_at' }[toStatus]
  const next = { ...n, status: toStatus }
  if (stamp && opts.at != null) next[stamp] = opts.at
  if (toStatus === 'sent' && opts.providerMessageId) next.provider_message_id = opts.providerMessageId
  return { ok: true, notification: next }
}
