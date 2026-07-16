// Phase 1B — AI BOUNDARY contract (pure). There is NO active AI Supervisor in this phase; all
// AI suggestion surfaces stay disabled behind flags (flags.aiSuggestions, default OFF). This
// module encodes, and lets tests assert, the hard rule: an AI actor may only PROPOSE — it may
// never perform, complete, approve, clear, or finalize a material loan action.

// Material actions an AI actor may NEVER perform.
export const AI_FORBIDDEN_ACTIONS = Object.freeze([
  'approve_loan', 'deny_loan', 'accept_document', 'clear_condition', 'complete_disclosures',
  'set_final_cash_to_close', 'promise_closing', 'complete_task_requiring_review',
  'alter_verified_financial_field', 'cancel_material_task',
])

// The only things an AI actor may produce — all advisory, all disabled behind flags.
export const AI_ALLOWED_PROPOSALS = Object.freeze([
  'explanation', 'summary', 'likely_missing_item', 'suggested_task', 'suggested_escalation',
  'draft_message', 'risk_observation',
])

export function aiMayPerform(action) {
  return false // an AI actor may perform NO material action, ever
}
export function aiMayPropose(kind) {
  return AI_ALLOWED_PROPOSALS.includes(kind)
}

// Build an inert AI proposal (never a real action). It carries requiresHumanApproval:true and
// is inert until a human acts. Returns { ok:false } for anything outside the allowed set.
export function makeAiProposal(kind, payload = {}) {
  if (!aiMayPropose(kind)) return { ok: false, error: 'ai_action_forbidden' }
  return {
    ok: true,
    proposal: Object.freeze({
      kind,
      payload,
      actor_type: 'ai',
      status: 'proposed',
      requires_human_approval: true,
      applied: false,
    }),
  }
}

// Guard for any action pipeline: throws-style boolean an executor can assert before acting.
export function assertNotAiActing(actorType, action) {
  if (actorType === 'ai') return { ok: false, error: 'ai_action_forbidden', action }
  return { ok: true }
}
