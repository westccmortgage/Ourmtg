// POST /.netlify/functions/portal-preapproval-set   (LO/owner-authed, Bearer JWT)
//
// Sets (or clears) the pre-approval band that becomes visible to the loan file's
// Realtor(s) via portal-status. This is the ONLY writer of loan_files.preapproval_* —
// sync-loan-file.mjs deliberately never touches these fields (see its header comment),
// so Realtor-facing exposure is always a deliberate LO action, never an automatic sync.
//
// Body: { loanFileId, amount, expires }
//   amount:  positive number, or null/omitted to clear
//   expires: 'YYYY-MM-DD', or null to clear (omit to leave unchanged)
//
// SECURITY
//   • Caller must be the loan_file's OWNER.
//   • Never touches app_state. Best-effort notifies any Realtor(s) already granted
//     portal_access to this file, so the update is actually seen, not just stored.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, loadLoanFile, resolveAccess, logAccess } from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'

const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

const isoDate = (v) => {
  if (v == null || v === '') return null
  const s = String(v).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)

  let amount = null
  if (body.amount != null && body.amount !== '') {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n <= 0) return json({ ok: false, error: 'amount must be a positive number' }, 400)
    amount = n
  }

  // expires: undefined (key absent) => leave unchanged; null/'' => clear; else parse.
  let expiresProvided = body.expires !== undefined
  let expires = null
  if (expiresProvided && body.expires != null && body.expires !== '') {
    expires = isoDate(body.expires)
    if (expires === null) return json({ ok: false, error: 'expires must be YYYY-MM-DD' }, 400)
  }

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-preapproval-set]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || access.role !== 'owner') {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  const patch = { preapproval_amount: amount }
  if (expiresProvided) patch.preapproval_expires = expires

  const { error: uErr } = await svc.from('loan_files').update(patch).eq('id', loanFileId)
  if (uErr) {
    console.error('[portal-preapproval-set] update failed:', uErr.message)
    return json({ ok: false, error: 'Could not update pre-approval' }, 500)
  }

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId, action: 'preapproval_set',
    target: amount != null ? String(amount) : 'cleared', req,
  })

  const finalExpires = expiresProvided ? expires : (loanFile.preapproval_expires ?? null)

  // Notify any Realtor(s) already granted access — fail-soft, best-effort.
  if (amount != null) {
    try {
      const { data: grants } = await svc
        .from('portal_access').select('portal_user')
        .eq('loan_file_id', loanFileId).eq('visibility', 'realtor')
      const ids = (grants || []).map((g) => g.portal_user)
      if (ids.length) {
        const { data: people } = await svc.from('portal_users').select('id, email').in('id', ids)
        for (const p of people || []) {
          if (!p.email) continue
          await sendPlatformEmail({
            to: p.email,
            subject: `Pre-approval issued${loanFile.borrower_name ? ' — ' + loanFile.borrower_name : ''}`,
            html: brandedEmail({
              heading: 'Your buyer is pre-approved',
              intro: `${esc(loanFile.borrower_name || 'Your referred buyer')} is pre-approved up to <strong>$${Number(amount).toLocaleString('en-US')}</strong>.`,
              bodyHtml: finalExpires ? `<p style="color:#6b7280;font-size:14px;margin:4px 0 0">Valid through ${esc(finalExpires)}.</p>` : '',
              cta: { text: 'View status', url: OURMTG_URL },
              note: 'Equal Housing Opportunity · West Coast Capital Mortgage',
            }),
            text: `${loanFile.borrower_name || 'Your referred buyer'} is pre-approved up to $${Number(amount).toLocaleString('en-US')}.${finalExpires ? ' Valid through ' + finalExpires + '.' : ''}`,
          })
        }
      }
    } catch (e) { console.warn('[portal-preapproval-set] realtor notify (non-fatal):', e.message) }
  }

  return json({ ok: true, loanFileId, preapprovalAmount: amount, preapprovalExpires: finalExpires })
}
