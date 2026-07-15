// Phase 0 scaffolding — canonical vocabulary surface.
//
// RULE: this file does NOT redefine any vocabulary the app already owns. It RE-EXPORTS the
// existing stage vocabulary from src/lib/pipeline.js (the single source), and defines ONLY the
// genuinely-new constants for objects that do not exist yet (domain events, tasks, vendor
// orders, deliveries). This is how we avoid a second, drifting copy of "the stages/statuses."
//
// Existing DB-enforced statuses that already have a home are intentionally NOT re-declared here:
//   - loan_documents.status  -> requested|uploaded|accepted|rejected   (migration 036 CHECK)
//   - loan_conditions.status -> open|submitted|cleared                 (migration 036 CHECK)
//   - loan_strategy.status   -> draft|approved|hidden                  (migration 036 CHECK)
//   - portal_access.visibility / portal_users.role / portal_invites.role
//                            -> borrower|coborrower|realtor|escrow|title (036 + 038 CHECK)
// The migration is their source of truth; do not fork them into JS.

// ── Re-export the existing stage vocabulary (do not redefine) ────────────────────────────────
export { STAGE_STEPS, STAGE_LABEL, MILESTONE_LABEL, STAGE_COLOR, stepIndex } from '../lib/pipeline.js'

// ── NEW: domain-event types (loan_events, draft B1). Dotted, past-tense-ish, stable strings. ──
// These do not exist anywhere in the app today, so defining them here is not duplication.
export const EVENT_TYPES = Object.freeze([
  'lead.created',
  'deal.stage_changed', // detail carries { from, to } where `to` ∈ existing STAGE_STEPS
  'doc.requested',
  'doc.uploaded',
  'doc.accepted',
  'doc.rejected',
  'condition.opened',
  'condition.submitted',
  'condition.cleared',
  'preapproval.set',
  'preapproval.cleared',
  'invite.created',
  'invite.accepted',
  'message.sent',
  'notification.sent',
  'ai.flag',
  'ai.next_best_action',
])

// ── NEW: statuses/types for proposed objects that do not exist yet ───────────────────────────
export const TASK_STATUS = Object.freeze(['open', 'done', 'cancelled'])
export const TASK_AUDIENCE = Object.freeze(['team', 'borrower'])

export const VENDOR_TYPE = Object.freeze(['appraisal', 'title', 'escrow', 'insurance'])
export const VENDOR_STATUS = Object.freeze(['ordered', 'in_progress', 'received', 'cleared', 'cancelled'])

export const DELIVERY_CHANNEL = Object.freeze(['email', 'sms'])
export const DELIVERY_STATUS = Object.freeze(['queued', 'sent', 'failed', 'skipped'])

export const CTC_DIRECTION = Object.freeze(['credit', 'charge'])

// The stage names an event's `deal.stage_changed.to` is allowed to reference. Kept as a getter
// so it always reflects pipeline.js and can never drift from it.
export { STAGE_STEPS as PIPELINE_STAGES } from '../lib/pipeline.js'
