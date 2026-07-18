// Phase 1B — canonical operational vocabulary + deterministic state machines.
//
// This is the SINGLE source for the new operational lifecycles (tasks, disclosures,
// milestones, cash-to-close classifications, third-party items, actors, events). It does NOT
// redefine the existing 7-stage pipeline vocabulary (that stays in src/lib/pipeline.js and is
// re-exported by vocab.js). Nothing here is wired into production; the task/event services
// that consume it are flag-gated and default OFF. Pure data + pure predicates only.

// ── Actor & responsible-party types ──────────────────────────────────────────────────
export const ACTOR_TYPE = Object.freeze([
  'borrower', 'coborrower', 'realtor', 'escrow', 'title',
  'loan_officer', 'processor', 'assistant', 'system', 'ai',
])
export const RESPONSIBLE_PARTY_TYPE = Object.freeze([
  'borrower', 'coborrower', 'loan_team', 'third_party', 'system',
])
// Actor types that are part of the internal loan team (may review/accept).
export const TEAM_ACTOR = Object.freeze(['loan_officer', 'processor', 'assistant'])
// Actor types the AI boundary treats as non-human automation.
export const AI_ACTOR = 'ai'

// ── Source systems (event/cash attribution) ──────────────────────────────────────────
export const SOURCE_TYPE = Object.freeze([
  'ourmtg', 'arive', 'grcrm', 'wcci', 'manual', 'borrower_upload', 'disclosure_provider', 'system',
])

// ── Task types ────────────────────────────────────────────────────────────────────────
export const TASK_TYPE = Object.freeze([
  'document_request', 'document_reupload', 'condition', 'signature', 'explanation',
  'appointment', 'missing_page', 'information_request', 'internal_review', 'other',
])
// Task types that require team review before they can be accepted (documents & conditions).
export const REVIEW_REQUIRED_TASK_TYPES = Object.freeze(['document_request', 'document_reupload', 'condition', 'signature'])

// ── Task lifecycle (13 states, required order) ─────────────────────────────────────────
export const TASK_STATUS = Object.freeze([
  'created', 'assigned', 'viewed', 'in_progress', 'submitted', 'prechecked',
  'team_review', 'accepted', 'rejected', 'more_information_needed', 'completed',
  'reopened', 'cancelled',
])
export const TASK_TERMINAL = Object.freeze(['completed', 'cancelled'])

// Deterministic transition graph: from -> allowed next states.
export const TASK_TRANSITIONS = Object.freeze({
  created: ['assigned', 'cancelled'],
  assigned: ['viewed', 'in_progress', 'cancelled'],
  viewed: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'cancelled'],
  submitted: ['prechecked', 'team_review', 'more_information_needed', 'rejected', 'cancelled'],
  prechecked: ['team_review', 'more_information_needed', 'rejected', 'cancelled'],
  team_review: ['accepted', 'rejected', 'more_information_needed'],
  rejected: ['in_progress', 'reopened', 'cancelled'],
  more_information_needed: ['in_progress', 'submitted', 'cancelled'],
  accepted: ['completed', 'reopened'],
  completed: ['reopened'],
  reopened: ['assigned', 'in_progress', 'cancelled'],
  cancelled: [],
})

// ── Disclosure lifecycle (11 states, required) — states must NOT be collapsed ──────────
export const DISCLOSURE_STATUS = Object.freeze([
  'prepared', 'sent', 'provider_accepted', 'delivered', 'bounced', 'opened',
  'viewed', 'partially_signed', 'completed', 'expired', 'resend_required',
])
export const DISCLOSURE_TERMINAL = Object.freeze(['completed'])
export const DISCLOSURE_TRANSITIONS = Object.freeze({
  prepared: ['sent'],
  sent: ['provider_accepted', 'bounced', 'expired', 'resend_required'],
  provider_accepted: ['delivered', 'bounced', 'expired'],
  delivered: ['opened', 'expired', 'resend_required'],
  bounced: ['resend_required'],
  opened: ['viewed', 'partially_signed', 'completed', 'expired'],
  viewed: ['partially_signed', 'completed', 'expired'],
  partially_signed: ['completed', 'expired', 'resend_required'],
  completed: [],
  expired: ['resend_required'],
  resend_required: ['sent'],
})

// ── Milestones (deterministic progress; distinct from the 7 pipeline stages) ───────────
export const MILESTONE_TYPE = Object.freeze([
  'application_started', 'preapproval_issued', 'processing_started', 'disclosures_sent',
  'disclosures_signed', 'appraisal_ordered', 'appraisal_received', 'underwriting_submitted',
  'conditions_issued', 'conditions_cleared', 'clear_to_close', 'closing_scheduled', 'funded',
])
export const MILESTONE_STATUS = Object.freeze(['pending', 'in_progress', 'completed', 'blocked', 'skipped'])

// ── Cash-to-close classification (confidence, ordered low→high) ────────────────────────
export const CASH_CLASSIFICATION = Object.freeze(['illustrative', 'estimated', 'verified', 'final'])
// A 'final' number is only legitimate from a verified final source (e.g. a Closing Disclosure).
export const FINAL_SOURCE_TYPES = Object.freeze(['closing_disclosure'])
export const CASH_CATEGORY = Object.freeze([
  'down_payment', 'closing_costs', 'points', 'prepaids', 'reserves', 'earnest_money',
  'seller_credit', 'lender_credit', 'other_credit', 'recording_government', 'title_escrow',
  'appraisal_third_party', 'homeowners_insurance', 'other',
])

// ── Third-party items ──────────────────────────────────────────────────────────────────
export const THIRD_PARTY_TYPE = Object.freeze(['appraisal', 'title', 'escrow', 'insurance'])
export const THIRD_PARTY_STATUS = Object.freeze([
  'not_started', 'ordered', 'scheduled', 'in_progress', 'received', 'completed', 'delayed', 'cancelled',
])

// ── Notification events (provider-neutral) ─────────────────────────────────────────────
export const NOTIFICATION_EVENT = Object.freeze([
  'task_created', 'task_due_soon', 'task_overdue', 'document_rejected',
  'disclosure_delivered_unopened', 'disclosure_opened_incomplete', 'appraisal_scheduled',
  'appraisal_overdue', 'cash_to_close_changed', 'stage_changed', 'clear_to_close', 'funded',
])
export const NOTIFICATION_STATUS = Object.freeze([
  'created', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'suppressed',
])

// ── Domain event types (superset; consumed as the canonical EVENT vocabulary) ──────────
export const EVENT_TYPES = Object.freeze([
  // Phase 0 base
  'lead.created', 'deal.stage_changed', 'doc.requested', 'doc.uploaded', 'doc.accepted',
  'doc.rejected', 'condition.opened', 'condition.submitted', 'condition.cleared',
  'preapproval.set', 'preapproval.cleared', 'invite.created', 'invite.accepted',
  'message.sent', 'notification.sent', 'ai.flag', 'ai.next_best_action',
  // Phase 1B operational
  'task.created', 'task.assigned', 'task.viewed', 'task.started', 'task.submitted',
  'task.prechecked', 'task.team_review', 'task.accepted', 'task.rejected',
  'task.more_information_needed', 'task.completed', 'task.reopened', 'task.cancelled',
  'milestone.reached', 'disclosure.status_changed', 'cashtoclose.updated',
  'thirdparty.status_changed', 'notification.queued',
])

// ── Pure transition predicates ─────────────────────────────────────────────────────────
export function canTaskTransition(from, to) {
  return (TASK_TRANSITIONS[from] || []).includes(to)
}
export function canDisclosureTransition(from, to) {
  return (DISCLOSURE_TRANSITIONS[from] || []).includes(to)
}
export function isTeamActor(actorType) {
  return TEAM_ACTOR.includes(actorType)
}
export function isAiActor(actorType) {
  return actorType === AI_ACTOR
}
