// POST /.netlify/functions/portal-doc-remove
// Internal users only.  Removes the private object and derived AI extraction from the active
// loan file, then leaves a content-free audit tombstone.  This is intentionally not exposed to
// borrowers and never accepts a storage path from the browser.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess } from './_lib/portal.mjs'
import { readJsonBody, isUuid } from './_lib/requestGuard.mjs'
import { isRemovedDocument, removalTombstone } from './_lib/documentState.mjs'

const BUCKET = 'ourmtg-docs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const { loanFileId, documentId, reason } = parsed.body
  if (!isUuid(loanFileId) || !isUuid(documentId)) return json({ ok: false, error: 'Invalid file or document ID' }, 400)

  let tombstone
  try { tombstone = removalTombstone(reason) }
  catch { return json({ ok: false, error: 'Tell us why this file is being removed' }, 400) }

  const svc = admin()
  const { data: document, error: documentError } = await svc.from('loan_documents')
    .select('id, loan_file_id, owner_user_id, doc_key, label, status, storage_path, reject_reason')
    .eq('id', documentId).eq('loan_file_id', loanFileId).maybeSingle()
  if (documentError) return json({ ok: false, error: 'Database error' }, 500)
  if (!document || isRemovedDocument(document)) return json({ ok: false, error: 'Document not found' }, 404)

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Only the loan team can remove a document' }, 403)

  // Destroy bytes first. If Storage refuses, the database row remains unchanged and visible so
  // the operator can retry; we never claim that sensitive content was removed when it was not.
  if (document.storage_path) {
    const { error: storageError } = await svc.storage.from(BUCKET).remove([document.storage_path])
    if (storageError) return json({ ok: false, error: 'The stored file could not be removed. Nothing was changed.' }, 502)
  }

  // Extracted values are copies of the source content and must not survive a mistaken upload.
  // Missing pre-underwriting tables are tolerated for older installations; other errors fail.
  const { error: extractionError } = await svc.from('document_extractions').delete().eq('document_id', document.id)
  if (extractionError && extractionError.code !== '42P01') {
    console.error('[portal-doc-remove] extraction cleanup failed')
    return json({ ok: false, error: 'The file was removed, but derived data cleanup needs attention.' }, 500)
  }

  const { error: updateError } = await svc.from('loan_documents').update({
    storage_path: null,
    status: 'rejected',
    uploaded_at: null,
    reviewed_at: new Date().toISOString(),
    reject_reason: tombstone,
  }).eq('id', document.id).eq('loan_file_id', loanFileId)
  if (updateError) {
    console.error('[portal-doc-remove] tombstone write failed after storage removal')
    return json({ ok: false, error: 'The file bytes were removed, but the file list needs attention.' }, 500)
  }

  await logAccess(svc, {
    portalUser: auth.user.id,
    loanFileId,
    action: 'remove_doc',
    target: `document:${document.id}`,
    req,
  })
  return json({ ok: true, documentId: document.id, removed: true })
}

