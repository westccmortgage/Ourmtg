// GET /.netlify/functions/portal-file-detail?loanFileId=<id>   (LO/team-authenticated)
// Returns the authorized loan-file detail, requested documents, borrower participants,
// conditions and messages. Financial document links are short-lived signed URLs.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess, stageInfo } from './_lib/portal.mjs'
import { listBorrowerParticipants } from './_lib/orgAccess.mjs'

const BUCKET = 'ourmtg-docs'
const DOWNLOAD_TTL = 300

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const loanFileId = String(new URL(req.url).searchParams.get('loanFileId') || '').trim()
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-file-detail] read error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  const { data: docs, error: dErr } = await svc
    .from('loan_documents')
    .select('id, doc_key, label, who, status, storage_path, uploaded_at, reviewed_at, reject_reason')
    .eq('loan_file_id', loanFileId)
    .order('requested_at', { ascending: true })
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)

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

  let participants = []
  try { participants = await listBorrowerParticipants(svc, loanFileId) }
  catch (e) {
    console.error('[portal-file-detail] participant read error')
    return json({ ok: false, error: 'Database error' }, 500)
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
    participants,
    conditions: conditions || [],
    messages: messages || [],
  })
}
