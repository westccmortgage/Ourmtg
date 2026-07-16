// Phase 1C — server-side TASK + EVENT repository (persistence adapter for the Phase 1B task
// service). Transition VALIDATION is delegated to the canonical pure service; PERSISTENCE is a
// SINGLE atomic RPC (ourmtg_task_create / ourmtg_task_transition) that writes task + history +
// event in one transaction. No raw table CRUD is exposed. Borrower reads are field-scoped here.
//
// The `db` client is injected (service-role Supabase in production; a fake in tests). It must
// provide db.rpc(name, params) → { data, error } and db.from(table) query builder.

// F7: import the FUNCTIONS-LOCAL state machine (self-contained; parity-tested vs src/domain).
import { transitionTask, ACTION_TO_STATUS } from './taskLifecycle.mjs'

const SOURCE_SYSTEM = 'ourmtg'
// task action → the loan_events event_type it emits.
const ACTION_EVENT = {
  assign: 'task.assigned', view: 'task.viewed', begin: 'task.started', submit: 'task.submitted',
  precheck: 'task.prechecked', sendToTeamReview: 'task.team_review', accept: 'task.accepted',
  reject: 'task.rejected', requestMoreInfo: 'task.more_information_needed', complete: 'task.completed',
  reopen: 'task.reopened', cancel: 'task.cancelled',
}

// Fields a borrower/coborrower may see. internal_requirement, internal metadata, evidence,
// created_by, responsible_user_id are NEVER returned to a borrower.
export function scrubTaskForBorrower(t) {
  if (!t) return t
  return {
    id: t.id,
    loan_file_id: t.loan_file_id,
    task_type: t.task_type,
    title: t.title,
    borrower_explanation: t.borrower_explanation,
    status: t.status,
    priority: t.priority,
    is_blocking: t.is_blocking,
    due_at: t.due_at,
    required_document_type: t.required_document_type,
    linked_document_id: t.linked_document_id,
    viewed_at: t.viewed_at, started_at: t.started_at, submitted_at: t.submitted_at,
    completed_at: t.completed_at, reopened_at: t.reopened_at,
    created_at: t.created_at, updated_at: t.updated_at,
  }
}

export function createTaskRepo({ db }) {
  if (!db || typeof db.rpc !== 'function') throw new Error('taskRepo requires a db with rpc()')

  async function getTask(taskId) {
    const { data, error } = await db.from('loan_tasks').select('*').eq('id', taskId).maybeSingle()
    if (error) throw new Error('getTask: ' + error.message)
    return data || null
  }

  async function listTasksForLoan(loanFileId, organizationId) {
    const { data, error } = await db.from('loan_tasks').select('*')
      .eq('loan_file_id', loanFileId).eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
    if (error) throw new Error('listTasksForLoan: ' + error.message)
    return data || []
  }

  async function listBorrowerVisibleTasks(loanFileId, organizationId) {
    const { data, error } = await db.from('loan_tasks').select('*')
      .eq('loan_file_id', loanFileId).eq('organization_id', organizationId)
      .in('responsible_party_type', ['borrower', 'coborrower'])
      .order('created_at', { ascending: false })
    if (error) throw new Error('listBorrowerVisibleTasks: ' + error.message)
    return (data || []).map(scrubTaskForBorrower)
  }

  async function getTaskHistory(taskId) {
    const { data, error } = await db.from('loan_task_history').select('*')
      .eq('task_id', taskId).order('created_at', { ascending: true })
    if (error) throw new Error('getTaskHistory: ' + error.message)
    return data || []
  }

  // Create a task (team/system only) atomically (task + history + event).
  async function createTask({ actor, input, correlationId, idempotencyKey, at }) {
    if (actor?.type === 'ai') return { ok: false, error: 'ai_forbidden' }
    if (['realtor', 'escrow', 'title'].includes(actor?.type)) return { ok: false, error: 'forbidden_role' }
    if (!['loan_officer', 'processor', 'assistant', 'system'].includes(actor?.type)) return { ok: false, error: 'forbidden_role' }
    if (!input?.organization_id || !input?.loan_file_id || !input?.title) return { ok: false, error: 'missing_fields' }
    let data, error
    try {
      ({ data, error } = await db.rpc('ourmtg_task_create', {
        p_organization_id: input.organization_id, p_loan_file_id: input.loan_file_id,
        p_task_type: input.task_type || 'document_request', p_title: input.title,
        p_borrower_explanation: input.borrower_explanation || null,
        p_internal_requirement: input.internal_requirement || null,
        p_responsible_party_type: input.responsible_party_type || 'borrower',
        p_responsible_user_id: input.responsible_user_id || null,
        p_priority: input.priority || 'normal', p_is_blocking: !!input.is_blocking,
        p_due_at: input.due_at || null, p_required_document_type: input.required_document_type || null,
        p_created_by: actor.id || null, p_actor_type: actor.type, p_actor_id: actor.id || null,
        p_source_system: SOURCE_SYSTEM, p_correlation_id: correlationId || null,
        p_idempotency_key: idempotencyKey || null, p_at: at || null,
      }))
    } catch (e) { return { ok: false, error: 'persist_failed', detail: e?.message } }
    if (error) return { ok: false, error: 'persist_failed', detail: error.message }
    return { ok: true, ...(data || {}) }
  }

  // Transition a task. VALIDATE via the pure service first (zero writes on invalid), then persist
  // atomically via the RPC. `task` is the current loaded row.
  async function transition({ task, action, actor, reason, evidence, linkedDocumentId, correlationId, idempotencyKey, at }) {
    const toStatus = ACTION_TO_STATUS[action]
    if (!toStatus) return { ok: false, error: 'unknown_action' }
    // Pure validation — role/AI/graph/review rules. On failure NOTHING is persisted.
    const v = transitionTask(task, action, actor, { reason, evidence, at })
    if (!v.ok) return v
    let data, error
    try {
      ({ data, error } = await db.rpc('ourmtg_task_transition', {
        p_task_id: task.id, p_to_status: toStatus, p_actor_type: actor.type, p_actor_id: actor.id || null,
        p_organization_id: task.organization_id, p_reason: reason || null,
        p_evidence: evidence != null ? evidence : null, p_event_type: ACTION_EVENT[action],
        p_linked_document_id: linkedDocumentId || null, p_idempotency_key: idempotencyKey || null,
        p_correlation_id: correlationId || null, p_source_system: SOURCE_SYSTEM, p_at: at || null,
      }))
    } catch (e) { return { ok: false, error: 'persist_failed', detail: e?.message } }
    if (error) return { ok: false, error: 'persist_failed', detail: error.message }
    return { ok: true, ...(data || {}) }
  }

  return { getTask, listTasksForLoan, listBorrowerVisibleTasks, getTaskHistory, createTask, transition }
}
