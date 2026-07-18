// GET /.netlify/functions/portal-task-detail?taskId=<id>   (JWT; task pilot)
// Internal → task + history. Borrower → field-scoped task, ONLY if they are a participant (EXT-7).
// Org resolved from the task's loan file (EXT-1). Gated by FF_TASK_PILOT (EXT-10).
import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess } from './_lib/portal.mjs'
import { resolveTaskContext } from './_lib/orgAccess.mjs'
import { createTaskRepo, scrubTaskForBorrower } from './_lib/taskRepo.mjs'
import { taskPilotEnabled } from './_lib/featureFlags.mjs'
import { isUuid } from './_lib/requestGuard.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!taskPilotEnabled()) return json({ ok: false, error: 'Not available' }, 404)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const taskId = new URL(req.url).searchParams.get('taskId')
  if (!isUuid(taskId)) return json({ ok: false, error: 'Invalid taskId' }, 400)

  const svc = admin()
  const repo = createTaskRepo({ db: svc })
  let task, loanFile, access, ctx
  try {
    task = await repo.getTask(taskId)
    if (!task) return json({ ok: false, error: 'Task not found' }, 404)
    loanFile = await loadLoanFile(svc, task.loan_file_id)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access)
  } catch (e) {
    console.error('[portal-task-detail] error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!ctx.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this loan' }, 503)
  if (!ctx.ok) return json({ ok: false, error: 'No access' }, 403)
  // Cross-org: the task's org must equal the file's org context.
  if (task.organization_id !== ctx.organizationId) return json({ ok: false, error: 'Cross-organization access denied' }, 403)

  await logAccess(svc, { portalUser: auth.user.id, loanFileId: task.loan_file_id, action: 'view_file', target: `task:${taskId}`, req })
  if (!ctx.isInternal) {
    if (!repo.borrowerCanSeeTask(task, auth.user.id)) return json({ ok: false, error: 'Not permitted' }, 403) // EXT-7
    return json({ ok: true, view: 'borrower', task: scrubTaskForBorrower(task) })
  }
  const history = await repo.getTaskHistory(taskId).catch(() => [])
  return json({ ok: true, view: 'team', task, history })
}
