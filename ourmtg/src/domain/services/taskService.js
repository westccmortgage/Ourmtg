// Phase 1B — pure task-domain service (FLAG-GATED: flags.taskServiceEnabled, default OFF).
//
// Deterministic state machine over the 13-state task lifecycle (lifecycles.js). No I/O: the
// service takes an injected persistence adapter so it is fully unit-testable and never touches
// production. Enforces role + AI boundaries. Not wired into any production endpoint.

import {
  TASK_STATUS, TASK_TRANSITIONS, REVIEW_REQUIRED_TASK_TYPES, TEAM_ACTOR,
  canTaskTransition,
} from '../lifecycles.js'

// Named actions → target status.
export const ACTION_TO_STATUS = Object.freeze({
  assign: 'assigned',
  view: 'viewed',
  begin: 'in_progress',
  submit: 'submitted',
  precheck: 'prechecked',
  sendToTeamReview: 'team_review',
  accept: 'accepted',
  reject: 'rejected',
  requestMoreInfo: 'more_information_needed',
  complete: 'completed',
  reopen: 'reopened',
  cancel: 'cancelled',
})

const BORROWER_ROLES = new Set(['borrower', 'coborrower'])
const PARTNER_ROLES = new Set(['realtor', 'escrow', 'title']) // no private financial task access
// Borrowers may only do their OWN work states; all review/decision states are team-only.
const BORROWER_ALLOWED = new Set(['viewed', 'in_progress', 'submitted'])
const SYSTEM_ALLOWED = new Set(['assigned', 'cancelled'])
// Timestamp field set when a status is reached (caller supplies the time via opts.at).
const STAMP = { viewed: 'viewed_at', in_progress: 'started_at', submitted: 'submitted_at', completed: 'completed_at', reopened: 'reopened_at' }

const isTeam = (actor) => TEAM_ACTOR.includes(actor?.type)
const isBorrower = (actor) => BORROWER_ROLES.has(actor?.type)
const isPartner = (actor) => PARTNER_ROLES.has(actor?.type)
const isAi = (actor) => actor?.type === 'ai'
const isSystem = (actor) => actor?.type === 'system'

// True if this actor may even SEE/ACT on this task. All tasks are private financial context;
// partner roles (realtor/escrow/title) are structurally excluded.
export function canAccessTask(actor) {
  return !isPartner(actor)
}

// Pure transition. Returns { ok:true, task, history } or { ok:false, error }.
export function transitionTask(task, action, actor, opts = {}) {
  if (!task || typeof task !== 'object') return { ok: false, error: 'no_task' }
  const toStatus = ACTION_TO_STATUS[action]
  if (!toStatus) return { ok: false, error: 'unknown_action' }

  // Role boundaries first.
  if (isPartner(actor)) return { ok: false, error: 'forbidden_role' } // realtor/escrow/title: no financial tasks
  if (isAi(actor)) return { ok: false, error: 'ai_forbidden' }        // AI may only propose, never act

  // Graph validity.
  if (!canTaskTransition(task.status, toStatus)) return { ok: false, error: 'invalid_transition' }

  // Per-actor permission on the target state.
  if (isTeam(actor)) {
    // team may perform any valid transition
  } else if (isBorrower(actor)) {
    if (!BORROWER_ALLOWED.has(toStatus)) return { ok: false, error: 'forbidden_action' } // e.g. cannot accept own doc
  } else if (isSystem(actor)) {
    if (!SYSTEM_ALLOWED.has(toStatus)) return { ok: false, error: 'forbidden_action' }
  } else {
    return { ok: false, error: 'forbidden_role' }
  }

  // Document/condition/signature tasks must pass through team_review before acceptance.
  if (toStatus === 'accepted' && REVIEW_REQUIRED_TASK_TYPES.includes(task.task_type) && task.status !== 'team_review') {
    return { ok: false, error: 'review_required' }
  }

  const next = { ...task, status: toStatus }
  if (STAMP[toStatus] && opts.at != null) next[STAMP[toStatus]] = opts.at
  // Reopen retains prior evidence + history (never wiped); optionally append new evidence.
  const evidence = Array.isArray(task.evidence) ? task.evidence.slice() : []
  if (opts.evidence) evidence.push(opts.evidence)
  next.evidence = evidence

  const history = {
    task_id: task.id ?? null,
    from_status: task.status,
    to_status: toStatus,
    actor_type: actor?.type ?? null,
    actor_id: actor?.id ?? null,
    reason: opts.reason ?? null,
    evidence: opts.evidence ?? null,
    created_at: opts.at ?? null,
  }
  return { ok: true, task: next, history }
}

// Service wrapper with an injected store: { saveTask(task), appendHistory(entry) }.
export function createTaskService({ store }) {
  if (!store) throw new Error('taskService requires a persistence store')

  async function createTask(input, actor, opts = {}) {
    if (isAi(actor)) return { ok: false, error: 'ai_forbidden' }
    if (isPartner(actor)) return { ok: false, error: 'forbidden_role' }
    if (!input?.organization_id || !input?.loan_file_id) return { ok: false, error: 'missing_scope' }
    if (input.task_type && !new Set(REVIEW_REQUIRED_TASK_TYPES.concat(['explanation', 'appointment', 'missing_page', 'information_request', 'internal_review', 'other'])).has(input.task_type)) {
      return { ok: false, error: 'unknown_task_type' }
    }
    const task = { ...input, status: 'created', evidence: [] }
    await store.saveTask(task)
    await store.appendHistory({ task_id: task.id ?? null, from_status: null, to_status: 'created', actor_type: actor?.type ?? null, actor_id: actor?.id ?? null, reason: opts.reason ?? null, evidence: null, created_at: opts.at ?? null })
    return { ok: true, task }
  }

  async function apply(task, action, actor, opts) {
    const r = transitionTask(task, action, actor, opts)
    if (!r.ok) return r
    await store.saveTask(r.task)
    await store.appendHistory(r.history)
    return r
  }

  return { createTask, apply, transitionTask }
}

export const TASK_STATUSES = TASK_STATUS
export const TASK_TRANSITION_GRAPH = TASK_TRANSITIONS
