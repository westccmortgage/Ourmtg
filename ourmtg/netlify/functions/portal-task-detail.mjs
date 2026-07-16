// GET /.netlify/functions/portal-task-detail?taskId=<id>   (JWT; task pilot)
// Returns one task (+ history for internal callers). Borrower view is field-scoped and omits
// internal history/notes. Organization + loan-file access enforced.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials, logAccess } from './_lib/portal.mjs'
import { memberOfOrg } from './_lib/orgAccess.mjs'
import { createTaskRepo, scrubTaskForBorrower } from './_lib/taskRepo.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const taskId = new URL(req.url).searchParams.get('taskId')
  if (!taskId) return json({ ok: false, error: 'Missing taskId' }, 400)

  const svc = admin()
  const repo = createTaskRepo({ db: svc })
  let task, loanFile, access, mem
  try {
    task = await repo.getTask(taskId)
    if (!task) return json({ ok: false, error: 'Task not found' }, 404)
    loanFile = await loadLoanFile(svc, task.loan_file_id)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    mem = await memberOfOrg(svc, auth.user.id, task.organization_id) // F3: scoped to the task's org
  } catch (e) {
    console.error('[portal-task-detail]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)
  if (!mem.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this environment' }, 503)
  if (!mem.ok) return json({ ok: false, error: 'Cross-organization access denied' }, 403)

  const internal = isInternal(access)
  if (!internal) {
    if (!canSeeFinancials(access.visibility)) return json({ ok: false, error: 'Not permitted' }, 403)
    if (!['borrower', 'coborrower'].includes(task.responsible_party_type)) return json({ ok: false, error: 'Not permitted' }, 403)
  }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId: task.loan_file_id, action: 'view_file', target: `task:${taskId}`, req })
  if (!internal) return json({ ok: true, view: 'borrower', task: scrubTaskForBorrower(task) })
  const history = await repo.getTaskHistory(taskId).catch(() => [])
  return json({ ok: true, view: 'team', task, history })
}
