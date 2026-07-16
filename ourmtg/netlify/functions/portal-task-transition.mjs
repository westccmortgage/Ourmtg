// POST /.netlify/functions/portal-task-transition   (JWT; task pilot)
// Transitions a task. VALIDATION is delegated to the canonical pure task service; PERSISTENCE is
// one atomic RPC (task + history + event). Borrower actions limited to view/begin/submit by the
// service. Idempotent per (task, action, pre-state). Records best-effort notification intents.
// Body: { taskId, action, reason?, evidence?, linkedDocumentId? }

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess, randomToken } from './_lib/portal.mjs'
import { memberOfOrg, actorTypeFor } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { notificationIntentFor } from './_lib/notificationIntent.mjs'

const ERR_STATUS = {
  unknown_action: 400, invalid_transition: 409, review_required: 409,
  forbidden_action: 403, forbidden_role: 403, ai_forbidden: 403, no_task: 404,
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const taskId = String(body.taskId || '').trim()
  const action = String(body.action || '').trim()
  if (!taskId || !action) return json({ ok: false, error: 'Missing taskId or action' }, 400)

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
    console.error('[portal-task-transition]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)
  if (!mem.provisioned) return json({ ok: false, error: 'Task pilot is not enabled for this environment' }, 503)
  if (!mem.ok) return json({ ok: false, error: 'Cross-organization access denied' }, 403)

  const actor = { type: actorTypeFor(access, access.teamRole), id: auth.user.id }
  // F4: include updated_at in the derived key so a LEGITIMATE repeat of the same (action, status)
  // after a reopen cycle is NOT falsely deduped — only a true concurrent double-submit (same
  // task row version) collides.
  const idempotencyKey = String(body.idempotencyKey || `${taskId}:${action}:${task.status}:${task.updated_at || ''}`)
  const correlationId = await randomToken(8)
  const reason = body.reason != null ? String(body.reason).slice(0, 2000) : null
  // Reject requires a borrower-visible reason.
  if (action === 'reject' && (!reason || reason.trim().length < 3)) {
    return json({ ok: false, error: 'A borrower-visible reason is required to reject' }, 400)
  }
  // F5: only INTERNAL (team) actors may attach evidence, and only if it serializes under a size
  // cap. Borrower-supplied evidence is ignored (never stored) to prevent injection/bloat of the
  // immutable history. Cap-or-drop (never truncate into invalid JSON).
  let evidence = null
  if (isInternal(access) && body.evidence != null) {
    try { if (JSON.stringify(body.evidence).length <= 4000) evidence = body.evidence } catch { /* drop */ }
  }

  const result = await repo.transition({
    task, action, actor, reason, evidence,
    // F6: linkedDocumentId is SERVER-SET only (via portal-doc-complete). Never trust it from the
    // public transition body (would allow linking an arbitrary document to a task — IDOR).
    linkedDocumentId: null,
    correlationId, idempotencyKey, at: new Date().toISOString(),
  })
  if (!result.ok) {
    const status = ERR_STATUS[result.error] || 400
    const msg = result.error === 'persist_failed' ? 'Could not update task' : result.error
    return json({ ok: false, error: msg }, result.error === 'persist_failed' ? 500 : status)
  }

  // Best-effort borrower notification intents on material team actions (no send in Phase 1C).
  const intent = notificationIntentFor(action, { taskId, loanFileId: task.loan_file_id })
  if (intent) {
    try {
      await svc.from('loan_events').insert({
        organization_id: org.organization_id, loan_file_id: task.loan_file_id, event_type: intent.event_type,
        actor_type: 'system', source_system: 'ourmtg', correlation_id: correlationId, metadata: intent.metadata,
      })
    } catch (e) { console.warn('[portal-task-transition] notification intent (non-fatal):', e?.message) }
  }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId: task.loan_file_id, action: 'view_file', target: `task_${action}`, req })
  return json({ ok: true, ...result })
}
