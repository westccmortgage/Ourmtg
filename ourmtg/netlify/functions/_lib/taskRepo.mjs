// Phase 1C — server-side task repository. The pure state machine fast-fails invalid
// actions; the database RPC remains authoritative for revision, relationship and atomic writes.

import { transitionTask, ACTION_TO_STATUS } from './taskLifecycle.mjs'

const SOURCE_SYSTEM = 'ourmtg'

export function scrubTaskForBorrower(t) {
  if (!t) return t
  return {
    id: t.id,
    loan_file_id: t.loan_file_id,
    task_type: t.task_type,
    title: t.title,
    borrower_explanation: t.borrower_explanation,
    borrower_visible_status_reason: t.borrower_visible_status_reason || null,
    status: t.status,
    revision: Number(t.revision || 0),
    priority: t.priority,
    is_blocking: t.is_blocking,
    due_at: t.due_at,
    required_document_id: t.required_document_id || null,
    required_document_type: t.required_document_type,
    linked_document_id: t.linked_document_id,
    viewed_at: t.viewed_at,
    started_at: t.started_at,
    submitted_at: t.submitted_at,
    completed_at: t.completed_at,
    reopened_at: t.reopened_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
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

  async function listBorrowerVisibleTasks(loanFileId, organizationId, userId) {
    const { data, error } = await db.from('loan_tasks').select('*')
      .eq('loan_file_id', loanFileId).eq('organization_id', organizationId)
      .in('responsible_party_type', ['borrower', 'coborrower'])
      .or(`shared_with_borrowers.eq.true,responsible_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
    if (error) throw new Error('listBorrowerVisibleTasks: ' + error.message)
    return (data || []).map(scrubTaskForBorrower)
  }

  function borrowerCanSeeTask(task, userId) {
    if (!task || !['borrower', 'coborrower'].includes(task.responsible_party_type)) return false
    return task.shared_with_borrowers === true || task.responsible_user_id === userId
  }

  async function getTaskHistory(taskId) {
    const { data, error } = await db.from('loan_task_history').select('*')
      .eq('task_id', taskId).order('created_at', { ascending: true })
    if (error) throw new Error('getTaskHistory: ' + error.message)
    return data || []
  }

  async function createTask({ actor, input, correlationId, idempotencyKey, requestHash, at }) {
    if (actor?.type === 'ai') return { ok: false, error: 'ai_forbidden' }
    if (['realtor', 'escrow', 'title'].includes(actor?.type)) return { ok: false, error: 'forbidden_role' }
    if (!['loan_officer', 'processor', 'assistant', 'system'].includes(actor?.type)) return { ok: false, error: 'forbidden_role' }
    if (!input?.organization_id || !input?.loan_file_id || !input?.title) return { ok: false, error: 'missing_fields' }
    let data, error
    try {
      ({ data, error } = await db.rpc('ourmtg_task_create', {
        p_organization_id: input.organization_id,
        p_loan_file_id: input.loan_file_id,
        p_task_type: input.task_type || 'document_request',
        p_title: input.title,
        p_borrower_explanation: input.borrower_explanation || null,
        p_internal_requirement: input.internal_requirement || null,
        p_responsible_user_id: input.responsible_user_id || null,
        p_shared_with_borrowers: !!input.shared_with_borrowers,
        p_priority: input.priority || 'normal',
        p_is_blocking: !!input.is_blocking,
        p_due_at: input.due_at || null,
        p_required_document_id: input.required_document_id || null,
        p_required_document_type: input.required_document_type || null,
        p_created_by: actor.id || null,
        p_actor_type: actor.type,
        p_actor_id: actor.id || null,
        p_source_system: SOURCE_SYSTEM,
        p_correlation_id: correlationId || null,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash || null,
        p_at: at || null,
      }))
    } catch (e) { return { ok: false, error: 'persist_failed', detail: e?.message } }
    if (error) return { ok: false, error: mapDbError(error), detail: error.message }
    return { ok: true, ...(data || {}) }
  }

  async function transition({ task, action, actor, reason, borrowerVisibleReason, evidence, expectedRevision, correlationId, idempotencyKey, requestHash, at }) {
    const toStatus = ACTION_TO_STATUS[action]
    if (!toStatus) return { ok: false, error: 'unknown_action' }
    const v = transitionTask(task, action, actor, { reason, evidence, at })
    if (!v.ok) return v
    let data, error
    try {
      ({ data, error } = await db.rpc('ourmtg_task_transition', {
        p_task_id: task.id,
        p_action: action,
        p_expected_revision: expectedRevision,
        p_actor_type: actor.type,
        p_actor_id: actor.id || null,
        p_organization_id: task.organization_id,
        p_reason: reason || null,
        p_borrower_visible_reason: borrowerVisibleReason || null,
        p_evidence: evidence != null ? evidence : null,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash || null,
        p_correlation_id: correlationId || null,
        p_source_system: SOURCE_SYSTEM,
        p_at: at || null,
      }))
    } catch (e) { return { ok: false, error: 'persist_failed', detail: e?.message } }
    if (error) return { ok: false, error: mapDbError(error), detail: error.message }
    return { ok: true, ...(data || {}) }
  }

  async function finalizeDocumentSubmit({ documentId, task, actor, expectedRevision, correlationId, idempotencyKey, requestHash, at }) {
    let data, error
    try {
      ({ data, error } = await db.rpc('ourmtg_document_finalize_submit', {
        p_document_id: documentId,
        p_task_id: task.id,
        p_organization_id: task.organization_id,
        p_actor_user_id: actor.id || null,
        p_actor_type: actor.type,
        p_expected_revision: expectedRevision,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash || null,
        p_correlation_id: correlationId || null,
        p_source_system: SOURCE_SYSTEM,
        p_at: at || null,
      }))
    } catch (e) { return { ok: false, error: 'persist_failed', detail: e?.message } }
    if (error) return { ok: false, error: mapDbError(error), detail: error.message }
    return { ok: true, ...(data || {}) }
  }

  return { getTask, listTasksForLoan, listBorrowerVisibleTasks, borrowerCanSeeTask, getTaskHistory, createTask, transition, finalizeDocumentSubmit }
}

export function mapDbError(error) {
  const m = String(error?.message || '')
  for (const code of [
    'idempotency_required', 'idempotency_conflict', 'stale_task', 'org_mismatch',
    'loan_org_mismatch', 'invalid_transition', 'review_required', 'reason_required',
    'forbidden_action', 'task_not_found', 'document_not_found', 'cross_loan_document',
    'not_borrower_task', 'not_participant', 'document_binding_mismatch',
    'required_document_missing', 'participant_invalid', 'audience_invalid',
  ]) {
    if (m.includes(code)) return code
  }
  return 'persist_failed'
}
