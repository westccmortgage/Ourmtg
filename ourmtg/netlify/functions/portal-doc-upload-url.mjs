// POST /.netlify/functions/portal-doc-upload-url   (portal-user-authed, Bearer JWT)
//
// Mints a short-lived SIGNED UPLOAD URL into the PRIVATE 'ourmtg-docs' bucket for one
// checklist document, and records/updates the loan_documents row. The client then
// PUTs the file to the returned signed URL (supabase.storage.uploadToSignedUrl), and
// afterwards calls portal-doc-complete to mark it uploaded.
//
// Body: { loanFileId, docKey }
//
// SECURITY (borrower financial data — strict)
//   • BORROWER / CO-BORROWER only. Realtors are rejected (canSeeFinancials=false) so a
//     realtor can never upload or touch borrower financial documents.
//   • Access is validated against portal_access for THIS loan file.
//   • docKey must be a valid slot for the file's loan type (isValidDocKey) — no
//     arbitrary paths.
//   • The storage path is SERVER-CONTROLLED: <owner>/<loanFile>/<docKey>-<rand>. The
//     borrower cannot choose a path into another file/owner.
//   • Private bucket only — never crm-media. Never touches app_state.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, logAccess, randomToken,
} from './_lib/portal.mjs'
import { isValidDocKey, labelForDocKey } from './_lib/checklist.mjs'

const BUCKET = 'ourmtg-docs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  const docKey = String(body.docKey || '').trim()
  if (!loanFileId || !docKey) return json({ ok: false, error: 'Missing loanFileId or docKey' }, 400)

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-doc-upload-url]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)
  // Realtors (and any non-financial visibility) can never upload borrower documents.
  if (!canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Not permitted to upload documents' }, 403)
  }

  // Validate the doc slot against the file's checklist.
  if (!isValidDocKey({ loanType: loanFile.loan_type, purpose: loanFile.purpose }, docKey)) {
    return json({ ok: false, error: 'Unknown document type for this loan' }, 400)
  }

  // Server-controlled path inside the private bucket.
  const rand = await randomToken(8)
  const storagePath = `${loanFile.owner_user_id}/${loanFileId}/${docKey}-${rand}`

  // Mint the signed upload URL (service role; private bucket).
  const { data: signed, error: sErr } = await svc
    .storage.from(BUCKET).createSignedUploadUrl(storagePath)
  if (sErr) {
    console.error('[portal-doc-upload-url] signed url failed:', sErr.message)
    return json({ ok: false, error: 'Could not prepare upload' }, 500)
  }

  // Upsert the loan_documents row for this (loanFile, docKey): point it at the new
  // path, reset to 'requested' until the client confirms completion. One slot per
  // docKey (re-upload replaces). Find existing first (no unique constraint on the pair).
  const label = labelForDocKey({ loanType: loanFile.loan_type, purpose: loanFile.purpose }, docKey)
  let documentId
  const { data: existing } = await svc
    .from('loan_documents')
    .select('id')
    .eq('loan_file_id', loanFileId).eq('doc_key', docKey)
    .maybeSingle()

  if (existing) {
    documentId = existing.id
    await svc.from('loan_documents').update({
      storage_path: storagePath, status: 'requested', label, uploaded_at: null, reviewed_at: null, reject_reason: null,
    }).eq('id', existing.id)
  } else {
    const { data: ins, error: dErr } = await svc.from('loan_documents').insert({
      loan_file_id: loanFileId,
      owner_user_id: loanFile.owner_user_id,
      doc_key: docKey,
      label,
      who: access.visibility === 'coborrower' ? 'coborrower' : 'borrower',
      status: 'requested',
      storage_path: storagePath,
    }).select('id').maybeSingle()
    if (dErr) {
      console.error('[portal-doc-upload-url] doc insert failed:', dErr.message)
      return json({ ok: false, error: 'Could not record document' }, 500)
    }
    documentId = ins.id
  }

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId, action: 'upload_doc', target: docKey, req,
  })

  return json({
    ok: true,
    documentId,
    bucket: BUCKET,
    path: storagePath,
    uploadUrl: signed.signedUrl,
    token: signed.token,   // for supabase.storage.from(BUCKET).uploadToSignedUrl(path, token, file)
  })
}
