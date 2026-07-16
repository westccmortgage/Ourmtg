// Phase 1B — provider-neutral disclosure tracking (FLAG-GATED: flags.disclosureTracking, OFF).
//
// Tracking + state model ONLY. This is NOT an e-sign integration and does not send anything.
// The 11 states are kept strictly DISTINCT — sent ≠ delivered ≠ opened ≠ completed — so the
// team can see exactly where a package is. Pure, no I/O.

import { DISCLOSURE_STATUS, DISCLOSURE_TRANSITIONS, canDisclosureTransition } from '../lifecycles.js'

export const BORROWER_DISCLOSURE_EXPLANATION =
  'These are your initial mortgage disclosures. They contain estimated terms, costs, and ' +
  'required notices. Signing them does not obligate you to complete the loan.'

// Team-facing labels — deliberately distinct per state (never collapsed).
export const TEAM_STATUS_LABEL = Object.freeze({
  prepared: 'Prepared (not sent)',
  sent: 'Sent to borrower',
  provider_accepted: 'Accepted by provider',
  delivered: 'Delivered to borrower',
  bounced: 'Bounced — undeliverable',
  opened: 'Opened by borrower',
  viewed: 'Viewed',
  partially_signed: 'Partially signed',
  completed: 'Completed (all signed)',
  expired: 'Expired',
  resend_required: 'Resend required',
})

// Borrower-facing labels — plainer, still distinct where it matters to the borrower.
export const BORROWER_STATUS_LABEL = Object.freeze({
  prepared: 'Being prepared',
  sent: 'On its way',
  provider_accepted: 'On its way',
  delivered: 'Ready to sign',
  bounced: "We couldn't reach you — please check your contact info",
  opened: 'Opened — please review and sign',
  viewed: 'In progress',
  partially_signed: 'Almost done — a few signatures left',
  completed: 'Completed',
  expired: 'Expired — we can resend',
  resend_required: "We'll resend these",
})

// Distinctness helpers — these must NOT be treated as the same thing.
export const isSent = (s) => s === 'sent'
export const isDelivered = (s) => s === 'delivered'
export const isOpened = (s) => s === 'opened' || s === 'viewed'
export const isCompleted = (s) => s === 'completed'
export function needsAttention(s) {
  return ['delivered', 'opened', 'viewed', 'partially_signed', 'bounced', 'expired', 'resend_required'].includes(s)
}

export function transitionDisclosure(pkg, toStatus, opts = {}) {
  if (!pkg || typeof pkg !== 'object') return { ok: false, error: 'no_package' }
  if (!DISCLOSURE_STATUS.includes(toStatus)) return { ok: false, error: 'unknown_status' }
  if (!canDisclosureTransition(pkg.status, toStatus)) return { ok: false, error: 'invalid_transition' }
  const stampKey = {
    sent: 'sent_at', delivered: 'delivered_at', opened: 'opened_at',
    partially_signed: 'partially_signed_at', completed: 'completed_at', expired: 'expired_at',
  }[toStatus]
  const next = { ...pkg, status: toStatus }
  if (stampKey && opts.at != null) next[stampKey] = opts.at
  if (toStatus === 'resend_required') next.resend_required = true
  return { ok: true, package: next }
}

export const DISCLOSURE_GRAPH = DISCLOSURE_TRANSITIONS
