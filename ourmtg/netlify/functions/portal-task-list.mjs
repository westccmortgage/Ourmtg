// GET /.netlify/functions/portal-task-list?loanFileId=<id>   (JWT; task pilot)
//
// Lists tasks for a loan file. Internal (owner/team) sees full task rows; borrower/co-borrower
// sees ONLY their borrower-facing tasks, field-scoped (no internal_requirement/notes/evidence).
// Realtor/escrow/title are denied (financial tasks). Organization boundary enforced.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials, logAccess } from './_lib/portal.mjs'
import { resolveOrg } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const loanFileId = new URL(req.url).searchParams.get('loanFileId')
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)

  const svc = admin()
  let loanFile, access, org
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    org = await resolveOrg(svc, auth.user.id)
  } catch (e) {
    console.error('[portal-task-list]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)
  if (!org.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this environment' }, 503)
  if (!org.ok) return json({ ok: false, error: 'No organization membership' }, 403)
  // Realtor/escrow/title: no financial tasks.
  if (!isInternal(access) && !canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Not permitted' }, 403)
  }

  const repo = createTaskRepo({ db: svc })
  try {
    const tasks = isInternal(access)
      ? await repo.listTasksForLoan(loanFileId, org.org.organization_id)
      : await repo.listBorrowerVisibleTasks(loanFileId, org.org.organization_id)
    await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'tasks', req })
    return json({ ok: true, view: isInternal(access) ? 'team' : 'borrower', tasks })
  } catch (e) {
    console.error('[portal-task-list]', e.message)
    return json({ ok: false, error: 'Could not load tasks' }, 500)
  }
}
