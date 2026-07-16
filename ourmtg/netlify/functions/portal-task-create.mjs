// POST /.netlify/functions/portal-task-create   (JWT; task pilot; INTERNAL only)
// Loan team creates ONE borrower document task on a file they can access. Atomic (task+history+
// event) via the repo/RPC. Records a best-effort borrower notification-INTENT event (no send).
// Body: { loanFileId, title, borrowerExplanation, internalRequirement?, dueAt?, isBlocking?,
//         requiredDocumentType?, taskType? }

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess, randomToken } from './_lib/portal.mjs'
import { resolveOrg, actorTypeFor } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { notificationIntentFor } from './_lib/notificationIntent.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  const title = String(body.title || '').trim()
  if (!loanFileId || !title) return json({ ok: false, error: 'Missing loanFileId or title' }, 400)

  const svc = admin()
  let loanFile, access, org
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
    org = await resolveOrg(svc, auth.user.id)
  } catch (e) {
    console.error('[portal-task-create]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Only the loan team can create tasks' }, 403)
  if (!org) return json({ ok: false, error: 'No organization membership' }, 403)

  const repo = createTaskRepo({ db: svc })
  const actor = { type: actorTypeFor(access, access.teamRole), id: auth.user.id }
  const correlationId = await randomToken(8)
  const idempotencyKey = `create:${loanFileId}:${await randomToken(6)}`
  const result = await repo.createTask({
    actor, correlationId, idempotencyKey, at: new Date().toISOString(),
    input: {
      organization_id: org.organization_id, loan_file_id: loanFileId,
      task_type: ['document_request', 'document_reupload', 'condition', 'signature', 'explanation',
        'appointment', 'missing_page', 'information_request'].includes(body.taskType) ? body.taskType : 'document_request',
      title: title.slice(0, 200),
      borrower_explanation: (body.borrowerExplanation || '').slice(0, 2000) || null,
      internal_requirement: (body.internalRequirement || '').slice(0, 2000) || null,
      responsible_party_type: 'borrower',
      priority: ['low', 'normal', 'high', 'urgent'].includes(body.priority) ? body.priority : 'normal',
      is_blocking: !!body.isBlocking,
      due_at: body.dueAt || null,
      required_document_type: (body.requiredDocumentType || '').slice(0, 80) || null,
    },
  })
  if (!result.ok) return json({ ok: false, error: result.error === 'persist_failed' ? 'Could not create task' : result.error }, 400)

  // Best-effort borrower notification INTENT (no send in Phase 1C).
  const intent = notificationIntentFor('create', { taskId: result.task_id, loanFileId })
  if (intent) {
    try {
      await svc.from('loan_events').insert({
        organization_id: org.organization_id, loan_file_id: loanFileId, event_type: intent.event_type,
        actor_type: 'system', source_system: 'ourmtg', correlation_id: correlationId, metadata: intent.metadata,
      })
    } catch (e) { console.warn('[portal-task-create] notification intent (non-fatal):', e?.message) }
  }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'task_create', req })
  return json({ ok: true, taskId: result.task_id })
}
