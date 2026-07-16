// GET /.netlify/functions/portal-task-list?loanFileId=<id>   (JWT; task pilot)
// Internal (owner/team, member of the file's org) → full task rows. Borrower/co-borrower →
// their PARTICIPANT-scoped borrower-facing tasks, field-scoped. Realtor/escrow/title → 403.
// Gated by the fail-closed server flag FF_TASK_PILOT (EXT-10).
import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess } from './_lib/portal.mjs'
import { resolveTaskContext } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { taskPilotEnabled } from './_lib/featureFlags.mjs'
import { isUuid } from './_lib/requestGuard.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!taskPilotEnabled()) return json({ ok: false, error: 'Not available' }, 404) // EXT-10 fail-closed
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const loanFileId = new URL(req.url).searchParams.get('loanFileId')
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)

  const svc = admin()
  let loanFile, access, ctx
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access)
  } catch (e) {
    console.error('[portal-task-list] error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!ctx.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this loan' }, 503)
  if (!ctx.ok) return json({ ok: false, error: ctx.error === 'forbidden_role' ? 'Not permitted' : 'No access' }, 403)

  const repo = createTaskRepo({ db: svc })
  try {
    const tasks = ctx.isInternal
      ? await repo.listTasksForLoan(loanFileId, ctx.organizationId)
      : await repo.listBorrowerVisibleTasks(loanFileId, ctx.organizationId, auth.user.id)
    await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'tasks', req })
    return json({ ok: true, view: ctx.isInternal ? 'team' : 'borrower', tasks })
  } catch (e) {
    console.error('[portal-task-list] load error')
    return json({ ok: false, error: 'Could not load tasks' }, 500)
  }
}
