// Phase 1C review fix (F7) — FUNCTIONS-LOCAL task state machine. Netlify functions must be
// self-contained (per OURMTG_HANDOFF: _lib is deliberately self-contained, not imported across
// the src/ boundary). This mirrors src/domain/lifecycles.js + services/taskService.js EXACTLY;
// tests/taskLifecycleParity.test.mjs asserts the two never drift. Server code imports from here.

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

export const ACTION_TO_STATUS = Object.freeze({
  assign: 'assigned', view: 'viewed', begin: 'in_progress', submit: 'submitted',
  precheck: 'prechecked', sendToTeamReview: 'team_review', accept: 'accepted', reject: 'rejected',
  requestMoreInfo: 'more_information_needed', complete: 'completed', reopen: 'reopened', cancel: 'cancelled',
})

export const REVIEW_REQUIRED_TASK_TYPES = Object.freeze(['document_request', 'document_reupload', 'condition', 'signature'])
export const TEAM_ACTOR = Object.freeze(['loan_officer', 'processor', 'assistant'])

const BORROWER_ROLES = new Set(['borrower', 'coborrower'])
const PARTNER_ROLES = new Set(['realtor', 'escrow', 'title'])
const BORROWER_ALLOWED = new Set(['viewed', 'in_progress', 'submitted'])
const SYSTEM_ALLOWED = new Set(['assigned', 'cancelled'])
const STAMP = { viewed: 'viewed_at', in_progress: 'started_at', submitted: 'submitted_at', completed: 'completed_at', reopened: 'reopened_at' }

const isTeam = (a) => TEAM_ACTOR.includes(a?.type)
const isBorrower = (a) => BORROWER_ROLES.has(a?.type)
const isPartner = (a) => PARTNER_ROLES.has(a?.type)
const isAi = (a) => a?.type === 'ai'
const isSystem = (a) => a?.type === 'system'

export function canTaskTransition(from, to) { return (TASK_TRANSITIONS[from] || []).includes(to) }
export function canAccessTask(actor) { return !isPartner(actor) }

// Pure transition validation (identical to src/domain/services/taskService.transitionTask).
export function transitionTask(task, action, actor, opts = {}) {
  if (!task || typeof task !== 'object') return { ok: false, error: 'no_task' }
  const toStatus = ACTION_TO_STATUS[action]
  if (!toStatus) return { ok: false, error: 'unknown_action' }
  if (isPartner(actor)) return { ok: false, error: 'forbidden_role' }
  if (isAi(actor)) return { ok: false, error: 'ai_forbidden' }
  if (!canTaskTransition(task.status, toStatus)) return { ok: false, error: 'invalid_transition' }
  if (isTeam(actor)) { /* any valid transition */ }
  else if (isBorrower(actor)) { if (!BORROWER_ALLOWED.has(toStatus)) return { ok: false, error: 'forbidden_action' } }
  else if (isSystem(actor)) { if (!SYSTEM_ALLOWED.has(toStatus)) return { ok: false, error: 'forbidden_action' } }
  else return { ok: false, error: 'forbidden_role' }
  if (toStatus === 'accepted' && REVIEW_REQUIRED_TASK_TYPES.includes(task.task_type) && task.status !== 'team_review') {
    return { ok: false, error: 'review_required' }
  }
  const next = { ...task, status: toStatus }
  if (STAMP[toStatus] && opts.at != null) next[STAMP[toStatus]] = opts.at
  const evidence = Array.isArray(task.evidence) ? task.evidence.slice() : []
  if (opts.evidence) evidence.push(opts.evidence)
  next.evidence = evidence
  const history = {
    task_id: task.id ?? null, from_status: task.status, to_status: toStatus,
    actor_type: actor?.type ?? null, actor_id: actor?.id ?? null,
    reason: opts.reason ?? null, evidence: opts.evidence ?? null, created_at: opts.at ?? null,
  }
  return { ok: true, task: next, history }
}
