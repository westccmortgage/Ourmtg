// POST /.netlify/functions/portal-doc-complete
// Legacy task-less uploads keep their existing completion/email behavior. A supplied taskId
// is fail-closed and uses the atomic document+task RPC; that pilot path records intent only
// and does not send email/SMS/push/webhook communications.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, logAccess, randomToken } from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'
import { resolveTaskContext } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'
import { taskPilotEnabled } from './_lib/featureFlags.mjs'
import { readJsonBody, isUuid, docTaskLinkDecision } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'

const BUCKET = 'ourmtg-docs'
const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body
  if (!isUuid(body.documentId)) return json({ ok: false, error: 'Invalid documentId' }, 400)

  const route = docTaskLinkDecision(body.taskId, taskPilotEnabled())
  if (route.mode === 'error') return json({ ok: false, error: route.error }, route.status)
  if (route.mode === 'task') {
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      return json({ ok: false, error: 'A valid expectedRevision is required' }, 400)
    }
    if (!isValidIdempotencyKey(body.idempotencyKey)) {
      return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
    }
  }

  const svc = admin()
  const { data: doc, error: dErr } = await svc
    .from('loan_documents')
    .select('id, loan_file_id, owner_user_id, doc_key, label, storage_path, status')
    .eq('id', body.documentId)
    .maybeSingle()
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)
  if (!doc) return json({ ok: false, error: 'Document not found' }, 404)

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, doc.loan_file_id)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    console.error('[portal-doc-complete] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!access || !canSeeFinancials(access.visibility)) return json({ ok: false, error: 'No access to this document' }, 403)
  if (!doc.storage_path) return json({ ok: false, error: 'No upload was prepared for this document' }, 409)

  const slash = doc.storage_path.lastIndexOf('/')
  const dir = slash >= 0 ? doc.storage_path.slice(0, slash) : ''
  const base = slash >= 0 ? doc.storage_path.slice(slash + 1) : doc.storage_path
  const { data: listed, error: lErr } = await svc.storage.from(BUCKET).list(dir, { search: base, limit: 100 })
  if (lErr) {
    console.error('[portal-doc-complete] storage verification failed')
    return json({ ok: false, error: 'Could not verify the upload — please try again' }, 502)
  }
  if (!Array.isArray(listed) || !listed.some((o) => o.name === base)) {
    return json({ ok: false, error: 'Upload not found — please try uploading again' }, 409)
  }

  let taskTransition = null
  if (route.mode === 'task') {
    const repo = createTaskRepo({ db: svc })
    let task
    try { task = await repo.getTask(route.taskId) }
    catch { return json({ ok: false, error: 'Database error' }, 500) }
    if (!task) return json({ ok: false, error: 'Task not found' }, 404)

    let ctx
    try { ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access) }
    catch { return json({ ok: false, error: 'Database error' }, 500) }
    if (!ctx.ok || ctx.isInternal) return json({ ok: false, error: 'Not permitted' }, 403)
    if (task.organization_id !== ctx.organizationId) return json({ ok: false, error: 'Cross-organization access denied' }, 403)
    if (!repo.borrowerCanSeeTask(task, auth.user.id)) return json({ ok: false, error: 'Not permitted' }, 403)
    if (task.required_document_id !== doc.id) return json({ ok: false, error: 'document_binding_mismatch' }, 409)

    const rHash = requestHash({
      documentId: doc.id,
      taskId: task.id,
      actor: auth.user.id,
      expectedRevision: body.expectedRevision,
    })
    const result = await repo.finalizeDocumentSubmit({
      documentId: doc.id,
      task,
      actor: { type: ctx.actorType, id: auth.user.id },
      expectedRevision: body.expectedRevision,
      correlationId: await randomToken(8),
      idempotencyKey: body.idempotencyKey,
      requestHash: rHash,
      at: new Date().toISOString(),
    })
    if (!result.ok) {
      const status = {
        stale_task: 409, cross_loan_document: 400, not_borrower_task: 403,
        not_participant: 403, document_binding_mismatch: 409, invalid_transition: 409,
        idempotency_conflict: 409, document_not_found: 404, task_not_found: 404,
        loan_org_mismatch: 409,
      }[result.error] || (result.error === 'persist_failed' ? 500 : 400)
      return json({ ok: false, error: result.error === 'persist_failed' ? 'Could not submit your document' : result.error }, status)
    }
    taskTransition = { ok: true, to: result.to || 'submitted', revision: result.revision, deduped: !!result.deduped }
  } else {
    const { error: uErr } = await svc.from('loan_documents')
      .update({ status: 'uploaded', uploaded_at: new Date().toISOString() })
      .eq('id', doc.id)
    if (uErr) return json({ ok: false, error: 'Could not mark uploaded' }, 500)
  }

  try {
    await svc.from('loan_messages').insert({
      loan_file_id: doc.loan_file_id,
      owner_user_id: doc.owner_user_id,
      direction: 'in',
      author_role: access.visibility === 'coborrower' ? 'coborrower' : 'borrower',
      body: `Uploaded: ${doc.label || doc.doc_key}`,
      channel: 'portal',
    })
  } catch { /* timeline is fail-soft */ }
  await logAccess(svc, { portalUser: auth.user.id, loanFileId: doc.loan_file_id, action: 'upload_doc_complete', target: doc.doc_key, req })

  // Task-linked Phase 1C is intent-only. Preserve the pre-existing email behavior solely for
  // the task-less legacy path.
  if (route.mode === 'legacy') {
    try {
      const { data: ownerData } = await svc.auth.admin.getUserById(doc.owner_user_id)
      const ownerEmail = ownerData?.user?.email
      if (ownerEmail) {
        await sendPlatformEmail({
          to: ownerEmail,
          subject: `📄 Document uploaded: ${doc.label || doc.doc_key}`,
          html: brandedEmail({
            heading: 'A borrower uploaded a document',
            intro: `${esc(loanFile.borrower_name || 'A borrower')} just uploaded a document to their loan file.`,
            rows: [['Borrower', loanFile.borrower_name || '—'], ['Document', doc.label || doc.doc_key], ['Loan #', loanFile.loan_number || '—']],
            cta: { text: 'Review in your dashboard', url: OURMTG_URL },
            note: 'Review and accept it in the loan file.',
          }),
          text: `${loanFile.borrower_name || 'A borrower'} uploaded: ${doc.label || doc.doc_key}.`,
        })
      }
    } catch { /* existing email is fail-soft */ }
    try {
      if (auth.user.email) {
        await sendPlatformEmail({
          to: auth.user.email,
          subject: 'We received your document',
          html: brandedEmail({
            heading: 'Got it — thank you!',
            intro: `We received your <strong>${esc(doc.label || doc.doc_key)}</strong>. Our team will review it shortly.`,
            cta: { text: 'Open your portal', url: OURMTG_URL },
            note: 'Equal Housing Opportunity · West Coast Capital Mortgage',
          }),
          text: `We received your ${doc.label || doc.doc_key}.`,
        })
      }
    } catch { /* existing email is fail-soft */ }
  }

  return json({ ok: true, documentId: doc.id, status: 'uploaded', ...(taskTransition ? { taskTransition } : {}) })
}
