// GET /.netlify/functions/portal-file-detail?loanFileId=<id>   (LO/owner-authed, Bearer JWT)
//
// Owner-only detail view behind the LO loan-file screen. The LO/owner has no RLS read
// path to loan_documents (those policies are borrower/co-borrower only) and needs the
// document IDs to accept/reject via portal-doc-review — this endpoint provides them,
// plus short-lived signed download URLs so the LO can actually view each upload.
//
// Returns: { ok, file, documents[], conditions[], messages[] }
//   • documents include a `downloadUrl` (300s signed) ONLY for uploaded/accepted docs.
//
// SECURITY
//   • Caller MUST be the loan file's owner (resolveAccess role === 'owner'). Portal
//     users (borrower/realtor) are rejected — they have their own scoped endpoints.
//   • Reads loan_files / loan_documents / loan_conditions / loan_messages ONLY. Never
//     app_state. Signed URLs are minted server-side on the private bucket after the
//     owner check, mirroring portal-doc-upload-url.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess, stageInfo } from './_lib/portal.mjs'

const BUCKET = 'ourmtg-docs'
const DOWNLOAD_TTL = 300 // seconds

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const url = new URL(req.url)
  const loanFileId = String(url.searchParams.get('loanFileId') || '').trim()
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-file-detail]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || access.role !== 'owner') {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  // Documents for this file.
  const { data: docs, error: dErr } = await svc
    .from('loan_documents')
    .select('id, doc_key, label, who, status, storage_path, uploaded_at, reviewed_at, reject_reason')
    .eq('loan_file_id', loanFileId)
    .order('requested_at', { ascending: true })
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)

  // Short-lived signed download URLs for anything the borrower actually uploaded.
  const documents = []
  for (const d of docs || []) {
    let downloadUrl = null
    if (d.storage_path && (d.status === 'uploaded' || d.status === 'accepted')) {
      const { data: signed } = await svc.storage.from(BUCKET).createSignedUrl(d.storage_path, DOWNLOAD_TTL)
      downloadUrl = signed?.signedUrl || null
    }
    documents.push({
      id: d.id,
      docKey: d.doc_key,
      label: d.label,
      who: d.who,
      status: d.status,
      uploadedAt: d.uploaded_at,
      reviewedAt: d.reviewed_at,
      rejectReason: d.status === 'rejected' ? d.reject_reason : null,
      downloadUrl,
    })
  }

  const [{ data: conditions }, { data: messages }] = await Promise.all([
    svc.from('loan_conditions')
      .select('id, title, detail, status, created_at, updated_at')
      .eq('loan_file_id', loanFileId).order('created_at', { ascending: true }),
    svc.from('loan_messages')
      .select('id, direction, author_role, body, channel, created_at')
      .eq('loan_file_id', loanFileId).order('created_at', { ascending: false }).limit(50),
  ])

  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'lo_detail', req })

  return json({
    ok: true,
    file: {
      loanFileId,
      borrowerName: loanFile.borrower_name || null,
      loanNumber: loanFile.loan_number || null,
      loanType: loanFile.loan_type || null,
      purpose: loanFile.purpose || null,
      stage: loanFile.stage,
      stageLabel: stageInfo(loanFile.stage).label,
      amount: loanFile.amount != null ? Number(loanFile.amount) : null,
      estCloseDate: loanFile.est_close_date || null,
      preapprovalAmount: loanFile.preapproval_amount != null ? Number(loanFile.preapproval_amount) : null,
      preapprovalExpires: loanFile.preapproval_expires || null,
    },
    documents,
    conditions: conditions || [],
    messages: messages || [],
  })
}
