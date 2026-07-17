// POST /.netlify/functions/portal-task-create
// Creates and immediately assigns one borrower task through the atomic create RPC.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess, randomToken } from './_lib/portal.mjs'
import { resolveTaskContext, verifyBorrowerParticipant, verifyTaskDocument } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { loanTeamTaskPilotEnabled } from './_lib/featureFlags.mjs'
import { readJsonBody, isUuid, isEnum, boundedString, isValidTimestamp } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'

const TASK_TYPES = ['document_request', 'document_reupload', 'condition', 'signature', 'explanation', 'appointment', 'missing_page', 'information_request']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']
const DOCUMENT_TASKS = new Set(['document_request', 'document_reupload', 'missing_page'])

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!loanTeamTaskPilotEnabled()) return json({ ok: false, error: 'Not available' }, 404)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body

  const loanFileId = body.loanFileId
  const title = boundedString(body.title, 200)
  const taskType = isEnum(body.taskType, TASK_TYPES) ? body.taskType : 'document_request'
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  if (!title) return json({ ok: false, error: 'A title is required' }, 400)
  if (!isValidIdempotencyKey(body.idempotencyKey)) return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
  if (body.taskType != null && !isEnum(body.taskType, TASK_TYPES)) return json({ ok: false, error: 'Invalid taskType' }, 400)
  if (body.priority != null && !isEnum(body.priority, PRIORITIES)) return json({ ok: false, error: 'Invalid priority' }, 400)
  if (!isValidTimestamp(body.dueAt)) return json({ ok: false, error: 'Invalid due date' }, 400)

  const shared = body.sharedWithBorrowers === true
  const responsibleUserId = body.responsibleUserId || null
  if (shared && responsibleUserId) return json({ ok: false, error: 'Shared tasks cannot target one participant' }, 400)
  if (!shared && !isUuid(responsibleUserId)) return json({ ok: false, error: 'Select a borrower participant' }, 400)

  const requiredDocumentId = body.requiredDocumentId || null
  if (DOCUMENT_TASKS.has(taskType) && !isUuid(requiredDocumentId)) {
    return json({ ok: false, error: 'Select the exact requested document' }, 400)
  }

  const svc = admin()
  let loanFile, access, ctx
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access)
  } catch {
    console.error('[portal-task-create] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!ctx.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this loan' }, 503)
  if (!ctx.ok || !ctx.isInternal) return json({ ok: false, error: 'Only the loan team can create tasks' }, 403)

  let participantVisibility = null
  if (responsibleUserId) {
    try {
      const participant = await verifyBorrowerParticipant(svc, loanFileId, responsibleUserId)
      if (!participant.ok) return json({ ok: false, error: 'The selected participant is not a borrower on this loan file' }, 400)
      participantVisibility = participant.visibility
    } catch {
      console.error('[portal-task-create] participant check error')
      return json({ ok: false, error: 'Database error' }, 500)
    }
  }

  if (requiredDocumentId) {
    try {
      const bound = await verifyTaskDocument(svc, loanFileId, requiredDocumentId)
      if (!bound.ok) return json({ ok: false, error: 'The selected document is not on this loan file' }, 400)
      if (participantVisibility && bound.document.who !== participantVisibility) {
        return json({ ok: false, error: 'The selected document belongs to a different borrower participant' }, 400)
      }
    } catch {
      console.error('[portal-task-create] document check error')
      return json({ ok: false, error: 'Database error' }, 500)
    }
  }

  const input = {
    organization_id: ctx.organizationId,
    loan_file_id: loanFileId,
    task_type: taskType,
    title,
    borrower_explanation: boundedString(body.borrowerExplanation, 2000),
    internal_requirement: boundedString(body.internalRequirement, 2000),
    responsible_user_id: responsibleUserId,
    shared_with_borrowers: shared,
    priority: isEnum(body.priority, PRIORITIES) ? body.priority : 'normal',
    is_blocking: !!body.isBlocking,
    due_at: body.dueAt ? new Date(body.dueAt).toISOString() : null,
    required_document_id: requiredDocumentId,
    required_document_type: boundedString(body.requiredDocumentType, 80),
  }
  const rHash = requestHash({ ...input, actor: auth.user.id })
  const result = await createTaskRepo({ db: svc }).createTask({
    actor: { type: ctx.actorType, id: auth.user.id },
    input,
    correlationId: await randomToken(8),
    idempotencyKey: body.idempotencyKey,
    requestHash: rHash,
    at: new Date().toISOString(),
  })
  if (!result.ok) {
    const status = result.error === 'idempotency_conflict' ? 409 : result.error === 'persist_failed' ? 500 : 400
    return json({ ok: false, error: result.error === 'persist_failed' ? 'Could not create task' : result.error }, status)
  }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'task_create', req })
  return json({ ok: true, taskId: result.task_id, status: result.status, revision: result.revision, deduped: !!result.deduped })
}
