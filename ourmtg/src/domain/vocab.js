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

// ── Domain-event types + task lifecycle: re-exported from the canonical Phase 1B module
// (src/domain/lifecycles.js) so there is ONE source, never a forked copy. The Phase 0
// placeholder TASK_STATUS (open/done/cancelled) is superseded by the full 13-state lifecycle.
export { EVENT_TYPES, TASK_STATUS } from './lifecycles.js'

// ── NEW: statuses/types for proposed objects that do not exist yet ───────────────────────────
export const TASK_AUDIENCE = Object.freeze(['team', 'borrower'])

export const VENDOR_TYPE = Object.freeze(['appraisal', 'title', 'escrow', 'insurance'])
export const VENDOR_STATUS = Object.freeze(['ordered', 'in_progress', 'received', 'cleared', 'cancelled'])

export const DELIVERY_CHANNEL = Object.freeze(['email', 'sms'])
export const DELIVERY_STATUS = Object.freeze(['queued', 'sent', 'failed', 'skipped'])

export const CTC_DIRECTION = Object.freeze(['credit', 'charge'])

// The stage names an event's `deal.stage_changed.to` is allowed to reference. Kept as a getter
// so it always reflects pipeline.js and can never drift from it.
export { STAGE_STEPS as PIPELINE_STAGES } from '../lib/pipeline.js'
