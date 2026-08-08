// GET /.netlify/functions/portal-checklist?loanFileId=<id>
// Borrower-safe document checklist. Each existing request includes its documentId so a
// task-linked upload can be bound to one exact loan_documents row.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, isInternal, logAccess } from './_lib/portal.mjs'
import { checklistFor } from './_lib/checklist.mjs'
import { providedBy, getDocumentType } from '../../src/features/pre-underwriting/documentCatalog.js'
import { assessCompleteness } from '../../src/features/pre-underwriting/completeness.js'
import { groupParts } from '../../src/features/pre-underwriting/extractionContract.js'

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
  } catch {
    console.error('[portal-checklist] read error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)
  if (!canSeeFinancials(access.visibility)) return json({ ok: false, error: 'Not permitted to view the checklist' }, 403)

  const ownerView = isInternal(access)
  const required = checklistFor({ loanType: loanFile.loan_type, purpose: loanFile.purpose })
  const { data: docs, error: dErr } = await svc
    .from('loan_documents')
    .select('id, doc_key, label, who, status, uploaded_at, reject_reason')
    .eq('loan_file_id', loanFileId)
    .order('requested_at', { ascending: true })
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)

  // What the reading layer knows about each upload, so "done" can mean COMPLETE rather than
  // merely "a file arrived". The gap messages are borrower-safe by construction — completeness
  // phrases every one as a request for a document, never as a conclusion about the person — and
  // only the messages travel; extracted values never leave the server here.
  let gapsByKey = {}
  try {
    const { data: reads } = await svc
      .from('document_extractions')
      .select('doc_key, fields')
      .eq('loan_file_id', loanFileId)
      .is('superseded_by', null)
    const parts = groupParts((reads || []).map((r) => ({
      docKey: r.doc_key, fields: r.fields?.fields || [], tradelines: [],
      taxForms: r.fields?.taxForms || [], taxLineItems: [],
    })))
    gapsByKey = Object.fromEntries(Object.keys(parts).map((k) => {
      const a = assessCompleteness(k, parts[k])
      return [k, { complete: a.complete, gaps: a.gaps.map((g) => g.message) }]
    }))
  } catch { /* the checklist must survive the analysis tables not existing yet */ }

  const completenessOf = (docKey, status) => {
    if (!['uploaded', 'accepted'].includes(status)) return { complete: false, gaps: [] }
    const read = gapsByKey[docKey]
    // Not read yet ⇒ nothing disproves it; claim nothing either way.
    if (!read) return { complete: true, gaps: [] }
    return read
  }

  const byKey = new Map((docs || []).map((d) => [d.doc_key, d]))
  const requiredKeys = new Set(required.map((it) => it.doc_key))
  const items = required.map((it) => {
    const row = byKey.get(it.doc_key)
    const c = completenessOf(it.doc_key, row?.status || 'missing')
    const base = {
      documentId: row?.id || null,
      docKey: it.doc_key,
      label: it.label,
      who: it.who,
      why: it.why || null,
      status: row?.status || 'missing',
      // A statement missing February is uploaded and NOT done. The messages name exactly what
      // to send, which is the whole difference between this list and a guilt trip.
      complete: c.complete,
      gaps: c.gaps,
      uploadedAt: row?.uploaded_at || null,
      rejectReason: row?.status === 'rejected' ? (row.reject_reason || null) : null,
    }
    if (ownerView) base.internalNote = it.internal || null
    return base
  })

  for (const d of docs || []) {
    if (requiredKeys.has(d.doc_key)) continue
    // Documents only the loan team can produce — the credit report above all — never appear on
    // the borrower's list. A borrower shown "credit_report · REPLACE" is being asked to obtain
    // something a consumer cannot obtain, with a raw key for a name.
    if (!ownerView && providedBy(d.doc_key) === 'loan_team') continue
    const c = completenessOf(d.doc_key, d.status)
    const extra = {
      documentId: d.id,
      docKey: d.doc_key,
      label: d.label && d.label !== d.doc_key ? d.label : (getDocumentType(d.doc_key)?.label || d.label || d.doc_key),
      who: d.who || 'borrower',
      status: d.status,
      complete: c.complete,
      gaps: c.gaps,
      uploadedAt: d.uploaded_at || null,
      rejectReason: d.status === 'rejected' ? (d.reject_reason || null) : null,
    }
    if (ownerView) extra.internalNote = null
    items.push(extra)
  }

  // "Done" now requires complete, not merely present. The borrower who sent one side of an ID
  // has NOT finished that item, and telling them "all in — nice work!" costs a day of silence.
  const uploaded = items.filter((i) => ['uploaded', 'accepted'].includes(i.status) && i.complete !== false).length
  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'checklist', req })
  return json({
    ok: true,
    view: ownerView ? 'owner' : 'borrower',
    loanFileId,
    loanType: loanFile.loan_type || null,
    purpose: loanFile.purpose || null,
    total: items.length,
    uploaded,
    remaining: items.length - uploaded,
    items,
  })
}
