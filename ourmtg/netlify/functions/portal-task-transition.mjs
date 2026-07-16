// POST /.netlify/functions/portal-task-transition
// All transitions use the validated repository + atomic RPC. The client must send the
// expected revision and a stable idempotency key so timeout retries return the original result.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess, randomToken } from './_lib/portal.mjs'
import { resolveTaskContext } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { taskPilotEnabled, loanTeamTaskPilotEnabled } from './_lib/featureFlags.mjs'
import { readJsonBody, isUuid, isEnum, boundedString } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'

const ACTIONS = ['assign', 'view', 'begin', 'submit', 'precheck', 'sendToTeamReview', 'accept', 'reject', 'requestMoreInfo', 'complete', 'reopen', 'cancel']
const REASON_ACTIONS = new Set(['reject', 'requestMoreInfo', 'reopen'])
const ERR_STATUS = {
  unknown_action: 400, invalid_transition: 409, review_required: 409, stale_task: 409,
  reason_required: 400, idempotency_conflict: 409, forbidden_action: 403,
  forbidden_role: 403, ai_forbidden: 403, task_not_found: 404,
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body
  if (!isUuid(body.taskId)) return json({ ok: false, error: 'Invalid taskId' }, 400)
  if (!isEnum(body.action, ACTIONS)) return json({ ok: false, error: 'Invalid action' }, 400)
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return json({ ok: false, error: 'A valid expectedRevision is required' }, 400)
  }
  if (!isValidIdempotencyKey(body.idempotencyKey)) return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)

  const svc = admin()
  const repo = createTaskRepo({ db: svc })
  let task, loanFile, access, ctx
  try {
    task = await repo.getTask(body.taskId)
    if (!task) return json({ ok: false, error: 'Task not found' }, 404)
    loanFile = await loadLoanFile(svc, task.loan_file_id)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access)
  } catch {
    console.error('[portal-task-transition] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!ctx.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this loan' }, 503)
  if (!ctx.ok) return json({ ok: false, error: 'No access' }, 403)
  if (task.organization_id !== ctx.organizationId) return json({ ok: false, error: 'Cross-organization access denied' }, 403)
  if (ctx.isInternal ? !loanTeamTaskPilotEnabled() : !taskPilotEnabled()) return json({ ok: false, error: 'Not available' }, 404)
  if (!ctx.isInternal && !repo.borrowerCanSeeTask(task, auth.user.id)) return json({ ok: false, error: 'Not permitted' }, 403)

  const action = body.action
  const reason = boundedString(body.reason, 2000)
  const borrowerVisibleReason = boundedString(body.borrowerVisibleReason, 2000)
  if (REASON_ACTIONS.has(action) && (!borrowerVisibleReason || borrowerVisibleReason.length < 3)) {
    return json({ ok: false, error: 'A borrower-visible reason is required' }, 400)
  }

  let evidence = null
  if (ctx.isInternal && body.evidence != null) {
    try { if (JSON.stringify(body.evidence).length <= 4000) evidence = body.evidence } catch { /* drop */ }
  }
  const rHash = requestHash({
    taskId: task.id,
    action,
    expectedRevision: body.expectedRevision,
    actor: auth.user.id,
    reason,
    borrowerVisibleReason,
    evidence,
  })

  const result = await repo.transition({
    task,
    action,
    actor: { type: ctx.actorType, id: auth.user.id },
    reason,
    borrowerVisibleReason,
    evidence,
    expectedRevision: body.expectedRevision,
    correlationId: await randomToken(8),
    idempotencyKey: body.idempotencyKey,
    requestHash: rHash,
    at: new Date().toISOString(),
  })
  if (!result.ok) {
    const status = ERR_STATUS[result.error] || (result.error === 'persist_failed' ? 500 : 400)
    return json({ ok: false, error: result.error === 'persist_failed' ? 'Could not update task' : result.error }, status)
  }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId: task.loan_file_id, action: 'view_file', target: `task_${action}`, req })
  return json({ ok: true, taskId: task.id, from: result.from, to: result.to, revision: result.revision, deduped: !!result.deduped })
}
