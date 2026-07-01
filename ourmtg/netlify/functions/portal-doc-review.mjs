// POST /.netlify/functions/portal-doc-review   (LO/owner-authed, Bearer JWT)
//
// LO accepts or rejects an uploaded document. Closes the loop started by
// portal-doc-upload-url / portal-doc-complete: a document sitting in status
// 'uploaded' is the LO's review queue; this is the only way it leaves that state.
//
// Body: { documentId, decision: 'accepted'|'rejected', rejectReason? }
//
// SECURITY
//   • Caller must be the OWNER of the document's loan file (LO/broker) — reviewing
//     is an internal action, never available to a portal user.
//   • Only a document currently 'uploaded' can be reviewed. The update carries a
//     WHERE status='uploaded' guard + a post-update row check, so two concurrent
//     review clicks can't both "win" and double-fire the borrower notification.
//   • Rejecting requires a reason (shown to the borrower so they know what to redo).
//   • Re-upload after rejection needs no new code: portal-doc-upload-url already
//     resets an existing loan_documents row (matched by doc_key) back to 'requested'.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess } from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'

const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')
const DECISIONS = new Set(['accepted', 'rejected'])

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const documentId = String(body.documentId || '').trim()
  const decision = String(body.decision || '').trim()
  const rejectReason = body.rejectReason ? String(body.rejectReason).trim().slice(0, 500) : null

  if (!documentId) return json({ ok: false, error: 'Missing documentId' }, 400)
  if (!DECISIONS.has(decision)) return json({ ok: false, error: 'decision must be accepted or rejected' }, 400)
  if (decision === 'rejected' && (!rejectReason || rejectReason.length < 3)) {
    return json({ ok: false, error: 'A reason is required to reject a document' }, 400)
  }

  const svc = admin()

  const { data: doc, error: dErr } = await svc
    .from('loan_documents')
    .select('id, loan_file_id, owner_user_id, doc_key, label, status')
    .eq('id', documentId)
    .maybeSingle()
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)
  if (!doc) return json({ ok: false, error: 'Document not found' }, 404)

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, doc.loan_file_id)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-doc-review]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!access || access.role !== 'owner') {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }
  if (doc.status !== 'uploaded') {
    return json({ ok: false, error: `Document is not awaiting review (status: ${doc.status})` }, 409)
  }

  // Guarded update: only succeeds from 'uploaded'. Check the returned row count so a
  // lost race (two reviews at once) reports a clean conflict instead of double-firing.
  const { data: updated, error: uErr } = await svc
    .from('loan_documents')
    .update({
      status: decision,
      reviewed_at: new Date().toISOString(),
      reject_reason: decision === 'rejected' ? rejectReason : null,
    })
    .eq('id', doc.id).eq('status', 'uploaded')
    .select('id')
  if (uErr) {
    console.error('[portal-doc-review] update failed:', uErr.message)
    return json({ ok: false, error: 'Could not update document' }, 500)
  }
  if (!updated || updated.length === 0) {
    return json({ ok: false, error: 'Document was already reviewed' }, 409)
  }

  // Timeline entry (portal tables only — never app_state).
  try {
    await svc.from('loan_messages').insert({
      loan_file_id: doc.loan_file_id,
      owner_user_id: doc.owner_user_id,
      direction: 'out',
      author_role: 'lo',
      body: decision === 'accepted'
        ? `Accepted: ${doc.label || doc.doc_key}`
        : `Needs another upload: ${doc.label || doc.doc_key} — ${rejectReason}`,
      channel: 'portal',
    })
  } catch (e) { console.warn('[portal-doc-review] message log (non-fatal):', e.message) }

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId: doc.loan_file_id, action: `doc_${decision}`, target: doc.doc_key, req,
  })

  // Notify the borrower ONLY on rejection — it's actionable (re-upload needed).
  // Acceptance stays silent-by-design (visible in-portal/checklist) so every single
  // accepted doc doesn't generate an email — same anti-noise rule as the automation engine.
  if (decision === 'rejected') {
    try {
      const { data: grants } = await svc
        .from('portal_access')
        .select('portal_user')
        .eq('loan_file_id', doc.loan_file_id)
        .in('visibility', ['borrower', 'coborrower'])
      const ids = (grants || []).map((g) => g.portal_user)
      if (ids.length) {
        const { data: people } = await svc.from('portal_users').select('id, email').in('id', ids)
        for (const p of people || []) {
          if (!p.email) continue
          await sendPlatformEmail({
            to: p.email,
            subject: `Please re-upload: ${doc.label || doc.doc_key}`,
            html: brandedEmail({
              heading: 'One document needs another look',
              intro: `We couldn't accept your <strong>${esc(doc.label || doc.doc_key)}</strong>:`,
              bodyHtml: `<div style="white-space:pre-wrap;color:#374151;font-size:15px;line-height:1.6;background:#f9fafb;border-radius:8px;padding:14px;margin-top:8px">${esc(rejectReason)}</div>`,
              cta: { text: 'Upload again', url: OURMTG_URL },
              note: 'Equal Housing Opportunity · West Coast Capital Mortgage',
            }),
            text: `We couldn't accept your ${doc.label || doc.doc_key}: ${rejectReason}\nUpload again: ${OURMTG_URL}`,
          })
        }
      }
    } catch (e) { console.warn('[portal-doc-review] borrower notify (non-fatal):', e.message) }
  }

  return json({ ok: true, documentId: doc.id, status: decision })
}
