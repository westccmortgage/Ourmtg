// POST /.netlify/functions/portal-doc-request   (internal: LO/owner or team, Bearer JWT)
//
// Request an AD-HOC document from the borrower — anything beyond the standard
// loan-type checklist ("LOE for the March deposit", "2019 tax return", …). Creates a
// loan_documents row with a server-generated custom doc_key; it then appears on the
// borrower's checklist and uploads through the exact same signed-URL flow
// (portal-doc-upload-url accepts any docKey that has an existing row).
//
// Body: { loanFileId, label, who? ('borrower'|'coborrower') }
//
// SECURITY
//   • Internal only (owner or portal_team member) — borrowers/realtors can't create
//     document slots.
//   • doc_key is SERVER-generated ('custom_' + hex) — the caller controls only the
//     human label, never the key/path shape.
//   • Emails the borrower side (fail-soft) so the request is actually seen.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
  randomToken, borrowerEmails,
} from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'

const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  const label = String(body.label || '').trim().slice(0, 200)
  const who = body.who === 'coborrower' ? 'coborrower' : 'borrower'
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)
  if (label.length < 3) return json({ ok: false, error: 'A document name is required' }, 400)

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-doc-request]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  const docKey = `custom_${await randomToken(4)}`
  const { data: ins, error: iErr } = await svc.from('loan_documents').insert({
    loan_file_id: loanFileId,
    owner_user_id: loanFile.owner_user_id,
    doc_key: docKey,
    label,
    who,
    status: 'requested',
  }).select('id').maybeSingle()
  if (iErr) {
    console.error('[portal-doc-request] insert failed:', iErr.message)
    return json({ ok: false, error: 'Could not create the request' }, 500)
  }

  // Timeline entry (portal tables only — never app_state).
  try {
    await svc.from('loan_messages').insert({
      loan_file_id: loanFileId,
      owner_user_id: loanFile.owner_user_id,
      direction: 'out',
      author_role: access.role === 'team' ? 'processor' : 'lo',
      body: `Requested: ${label}`,
      channel: 'portal',
    })
  } catch (e) { console.warn('[portal-doc-request] message log (non-fatal):', e.message) }

  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'doc_requested', target: docKey, req })

  // Notify the borrower side — fail-soft.
  try {
    for (const to of await borrowerEmails(svc, loanFileId)) {
      await sendPlatformEmail({
        to,
        subject: `One more item needed: ${label}`,
        html: brandedEmail({
          heading: 'We need one more document',
          intro: `To keep your loan moving, please upload: <strong>${esc(label)}</strong>.`,
          cta: { text: 'Upload now', url: OURMTG_URL },
          note: 'Equal Housing Opportunity · West Coast Capital Mortgage',
        }),
        text: `Please upload: ${label}. Open your portal: ${OURMTG_URL}`,
      })
    }
  } catch (e) { console.warn('[portal-doc-request] notify (non-fatal):', e.message) }

  return json({ ok: true, documentId: ins.id, docKey, label, status: 'requested' })
}
