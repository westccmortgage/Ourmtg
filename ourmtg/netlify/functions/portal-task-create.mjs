// POST /.netlify/functions/portal-task-create   (JWT; INTERNAL only; FF_LOAN_TEAM_TASK_PILOT)
// Loan team creates ONE borrower task on a file they can access + are an org member of. Atomic
// (task + history + event + in-tx notification-intent) via the create RPC. Mandatory idempotency
// key + material-payload hash (EXT-8). Participant selection required (EXT-7).
import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess, randomToken } from './_lib/portal.mjs'
import { resolveTaskContext } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { loanTeamTaskPilotEnabled } from './_lib/featureFlags.mjs'
import { readJsonBody, isUuid, isEnum, boundedString, isValidTimestamp } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'

const TASK_TYPES = ['document_request', 'document_reupload', 'condition', 'signature', 'explanation', 'appointment', 'missing_page', 'information_request']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!loanTeamTaskPilotEnabled()) return json({ ok: false, error: 'Not available' }, 404) // EXT-10
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)           // EXT-11
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body

  const loanFileId = body.loanFileId
  const title = boundedString(body.title, 200)
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  if (!title) return json({ ok: false, error: 'A title is required' }, 400)
  // EXT-8: idempotency key is MANDATORY (no random fallback).
  if (!isValidIdempotencyKey(body.idempotencyKey)) return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
  if (body.taskType != null && !isEnum(body.taskType, TASK_TYPES)) return json({ ok: false, error: 'Invalid taskType' }, 400)
  if (body.priority != null && !isEnum(body.priority, PRIORITIES)) return json({ ok: false, error: 'Invalid priority' }, 400)
  if (!isValidTimestamp(body.dueAt)) return json({ ok: false, error: 'Invalid due date' }, 400)
  // EXT-7: participant selection required — a specific participant OR shared-with-borrowers.
  const shared = body.sharedWithBorrowers === true
  const responsibleUserId = body.responsibleUserId != null ? body.responsibleUserId : null
  if (responsibleUserId != null && !isUuid(responsibleUserId)) return json({ ok: false, error: 'Invalid responsibleUserId' }, 400)
  if (!shared && !responsibleUserId) return json({ ok: false, error: 'Select a participant or share with borrowers' }, 400)

  const svc = admin()
  let loanFile, access, ctx
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access)
  } catch (e) {
    console.error('[portal-task-create] error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!ctx.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this loan' }, 503)
  if (!ctx.ok || !ctx.isInternal) return json({ ok: false, error: 'Only the loan team can create tasks' }, 403)

  const dueAt = body.dueAt ? new Date(body.dueAt).toISOString() : null
  const input = {
    organization_id: ctx.organizationId, loan_file_id: loanFileId,
    task_type: isEnum(body.taskType, TASK_TYPES) ? body.taskType : 'document_request',
    title,
    borrower_explanation: boundedString(body.borrowerExplanation, 2000),
    internal_requirement: boundedString(body.internalRequirement, 2000),
    responsible_party_type: 'borrower',
    responsible_user_id: responsibleUserId, shared_with_borrowers: shared,
    priority: isEnum(body.priority, PRIORITIES) ? body.priority : 'normal',
    is_blocking: !!body.isBlocking, due_at: dueAt,
    required_document_type: boundedString(body.requiredDocumentType, 80),
  }
  // EXT-8: canonical hash of the MATERIAL payload (what defines the task).
  const rHash = requestHash({ ...input, actor: auth.user.id })
  const repo = createTaskRepo({ db: svc })
  const result = await repo.createTask({
    actor: { type: ctx.actorType, id: auth.user.id }, input,
    correlationId: await randomToken(8), idempotencyKey: body.idempotencyKey, requestHash: rHash,
    at: new Date().toISOString(),
  })
  if (!result.ok) {
    const map = { idempotency_conflict: 409, missing_fields: 400 }
    return json({ ok: false, error: result.error === 'persist_failed' ? 'Could not create task' : result.error }, map[result.error] || (result.error === 'persist_failed' ? 500 : 400))
  }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'task_create', req })
  return json({ ok: true, taskId: result.task_id, deduped: !!result.deduped })
}
