// POST /.netlify/functions/portal-doc-upload-url
// Mints a private signed upload URL. A task-linked request is fail-closed and must match
// the exact required loan_documents row and authorized borrower participant.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, logAccess, randomToken, storageDocPath } from './_lib/portal.mjs'
import { isValidDocKey, labelForDocKey } from './_lib/checklist.mjs'
import { validateUpload, hasDangerousExtension } from './_lib/upload-policy.mjs'
import { readJsonBody, isUuid, docTaskLinkDecision } from './_lib/requestGuard.mjs'
import { taskPilotEnabled } from './_lib/featureFlags.mjs'
import { resolveTaskContext } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'

const BUCKET = 'ourmtg-docs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body
  if (!isUuid(body.loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  const docKey = String(body.docKey || '').trim()
  if (!docKey) return json({ ok: false, error: 'Missing docKey' }, 400)
  if (body.documentId != null && !isUuid(body.documentId)) return json({ ok: false, error: 'Invalid documentId' }, 400)

  if (body.filename && hasDangerousExtension(body.filename)) return json({ ok: false, error: 'This file type is not allowed' }, 400)
  if (body.contentType) {
    const v = validateUpload({ contentType: body.contentType, filename: body.filename })
    if (!v.ok) return json({ ok: false, error: v.error }, 400)
  }

  const route = docTaskLinkDecision(body.taskId, taskPilotEnabled())
  if (route.mode === 'error') return json({ ok: false, error: route.error }, route.status)
  if (route.mode === 'task' && !isUuid(body.documentId)) return json({ ok: false, error: 'A task upload requires the exact documentId' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, body.loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    console.error('[portal-doc-upload-url] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || !canSeeFinancials(access.visibility)) return json({ ok: false, error: 'Not permitted to upload documents' }, 403)

  let existing = null
  if (body.documentId) {
    const { data, error } = await svc.from('loan_documents')
      .select('id, label, who, status, doc_key')
      .eq('id', body.documentId).eq('loan_file_id', body.loanFileId).eq('doc_key', docKey)
      .maybeSingle()
    if (error) return json({ ok: false, error: 'Database error' }, 500)
    if (!data) return json({ ok: false, error: 'Document request not found' }, 404)
    existing = data
  } else {
    const { data, error } = await svc.from('loan_documents')
      .select('id, label, who, status, doc_key')
      .eq('loan_file_id', body.loanFileId).eq('doc_key', docKey)
      .maybeSingle()
    if (error) return json({ ok: false, error: 'Database error' }, 500)
    existing = data || null
  }

  if (!existing && !isValidDocKey({ loanType: loanFile.loan_type, purpose: loanFile.purpose }, docKey)) {
    return json({ ok: false, error: 'Unknown document type for this loan' }, 400)
  }

  if (route.mode === 'task') {
    const repo = createTaskRepo({ db: svc })
    let task, ctx
    try {
      task = await repo.getTask(route.taskId)
      ctx = await resolveTaskContext(svc, auth.user.id, loanFile, access)
    } catch { return json({ ok: false, error: 'Database error' }, 500) }
    if (!task) return json({ ok: false, error: 'Task not found' }, 404)
    if (!ctx.ok || ctx.isInternal || task.organization_id !== ctx.organizationId) return json({ ok: false, error: 'Not permitted' }, 403)
    if (!repo.borrowerCanSeeTask(task, auth.user.id)) return json({ ok: false, error: 'Not permitted' }, 403)
    if (task.status !== 'in_progress') return json({ ok: false, error: 'Task is not ready for upload' }, 409)
    if (task.required_document_id !== existing.id) return json({ ok: false, error: 'document_binding_mismatch' }, 409)
  }

  const storagePath = storageDocPath(loanFile.owner_user_id, body.loanFileId, docKey, await randomToken(8))
  const { data: signed, error: sErr } = await svc.storage.from(BUCKET).createSignedUploadUrl(storagePath)
  if (sErr) return json({ ok: false, error: 'Could not prepare upload' }, 500)

  const label = existing?.label || labelForDocKey({ loanType: loanFile.loan_type, purpose: loanFile.purpose }, docKey)
  let documentId
  if (existing) {
    documentId = existing.id
    const { error } = await svc.from('loan_documents').update({
      storage_path: storagePath, status: 'requested', label,
      uploaded_at: null, reviewed_at: null, reject_reason: null,
    }).eq('id', existing.id)
    if (error) return json({ ok: false, error: 'Could not record document' }, 500)
  } else {
    const { data: inserted, error } = await svc.from('loan_documents').insert({
      loan_file_id: body.loanFileId, owner_user_id: loanFile.owner_user_id,
      doc_key: docKey, label,
      who: access.visibility === 'coborrower' ? 'coborrower' : 'borrower',
      status: 'requested', storage_path: storagePath,
    }).select('id').maybeSingle()
    if (error) return json({ ok: false, error: 'Could not record document' }, 500)
    documentId = inserted.id
  }

  await logAccess(svc, { portalUser: auth.user.id, loanFileId: body.loanFileId, action: 'upload_doc', target: docKey, req })
  return json({ ok: true, documentId, bucket: BUCKET, path: storagePath, uploadUrl: signed.signedUrl, token: signed.token })
}
