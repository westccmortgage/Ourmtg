// GET /.netlify/functions/portal-checklist?loanFileId=<id>   (portal-user-authed, Bearer JWT)
//
// Returns the document checklist for a loan file: required docs (derived from loan
// type + purpose) joined with what's been uploaded, so the borrower sees uploaded vs
// missing with friendly labels.
//
// VISIBILITY
//   • borrower / co-borrower → borrower-facing items only. INTERNAL LO notes are
//     stripped (never sent to a borrower).
//   • owner (LO)            → same items PLUS the separated `internalNote` per item.
//   • realtor              → 403. A checklist is borrower financial data.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, isInternal, logAccess,
} from './_lib/portal.mjs'
import { checklistFor } from './_lib/checklist.mjs'

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
    console.error('[portal-checklist]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)
  if (!canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Not permitted to view the checklist' }, 403)
  }

  const isOwner = isInternal(access) // owner OR team member (processor/assistant)

  // Required items from the file's loan type / purpose.
  const required = checklistFor({ loanType: loanFile.loan_type, purpose: loanFile.purpose })

  // Existing document rows for this file, keyed by doc_key.
  const { data: docs, error: dErr } = await svc
    .from('loan_documents')
    .select('doc_key, label, who, status, uploaded_at, reject_reason')
    .eq('loan_file_id', loanFileId)
    .order('requested_at', { ascending: true })
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)

  const byKey = new Map((docs || []).map((d) => [d.doc_key, d]))
  const requiredKeys = new Set(required.map((it) => it.doc_key))

  const items = required.map((it) => {
    const row = byKey.get(it.doc_key)
    const status = row?.status || 'missing' // missing | requested | uploaded | accepted | rejected
    const base = {
      docKey: it.doc_key,
      label: it.label,
      who: it.who,
      why: it.why || null,
      status,
      uploadedAt: row?.uploaded_at || null,
      rejectReason: row?.status === 'rejected' ? (row?.reject_reason || null) : null,
    }
    // LO-only internal note is SEPARATED — attached only for the owner view.
    if (isOwner) base.internalNote = it.internal || null
    return base
  })

  // Ad-hoc requests (portal-doc-request) — rows whose doc_key isn't in the standard
  // checklist. Appended after the standard items so the borrower sees them too.
  for (const d of docs || []) {
    if (requiredKeys.has(d.doc_key)) continue
    const extra = {
      docKey: d.doc_key,
      label: d.label || d.doc_key,
      who: d.who || 'borrower',
      status: d.status,
      uploadedAt: d.uploaded_at || null,
      rejectReason: d.status === 'rejected' ? (d.reject_reason || null) : null,
    }
    if (isOwner) extra.internalNote = null
    items.push(extra)
  }

  const uploaded = items.filter((i) => ['uploaded', 'accepted'].includes(i.status)).length

  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'checklist', req })

  return json({
    ok: true,
    view: isOwner ? 'owner' : 'borrower',
    loanFileId,
    loanType: loanFile.loan_type || null,
    purpose: loanFile.purpose || null,
    total: items.length,
    uploaded,
    remaining: items.length - uploaded,
    items,
  })
}
