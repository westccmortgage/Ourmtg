// POST /.netlify/functions/portal-message-send   (any file participant, Bearer JWT)
//
// Two-way portal messaging on a loan file. A borrower/co-borrower writes to the loan
// team; the LO/processor writes to the borrower. Message lands in loan_messages (the
// timeline) and the other side gets an email nudge (fail-soft).
//
// Body: { loanFileId, body }
//
// SECURITY
//   • Caller must have access to the file: internal (owner/team) OR a borrower/
//     co-borrower grant. Realtors/escrow/title CANNOT message through the file —
//     the timeline carries financial context (mirrors the 038 RLS tightening).
//   • Writes loan_messages via service role. Never app_state.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials,
  logAccess, borrowerEmails,
} from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'

const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const payload = await req.json().catch(() => ({}))
  const loanFileId = String(payload.loanFileId || '').trim()
  const text = String(payload.body || '').trim().slice(0, 4000)
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)
  if (text.length < 1) return json({ ok: false, error: 'Message is empty' }, 400)

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-message-send]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)

  const internal = isInternal(access)
  // Only the borrower side and the loan team converse through the file.
  if (!internal && !canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Messaging is not available for this role' }, 403)
  }

  const authorRole = internal
    ? (access.role === 'team' ? 'processor' : 'lo')
    : (access.visibility === 'coborrower' ? 'coborrower' : 'borrower')

  const { data: msg, error: mErr } = await svc.from('loan_messages').insert({
    loan_file_id: loanFileId,
    owner_user_id: loanFile.owner_user_id,
    direction: internal ? 'out' : 'in',
    author_role: authorRole,
    body: text,
    channel: 'portal',
  }).select('id, direction, author_role, body, channel, created_at').maybeSingle()
  if (mErr) {
    console.error('[portal-message-send] insert failed:', mErr.message)
    return json({ ok: false, error: 'Could not send message' }, 500)
  }

  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'message_sent', target: authorRole, req })

  // ── Email nudge to the other side — fail-soft ─────────────────────────────────
  try {
    const preview = text.length > 300 ? text.slice(0, 300) + '…' : text
    if (internal) {
      for (const to of await borrowerEmails(svc, loanFileId)) {
        await sendPlatformEmail({
          to,
          subject: 'New message from your loan team',
          html: brandedEmail({
            heading: 'You have a new message',
            intro: 'Your loan team wrote:',
            bodyHtml: `<div style="white-space:pre-wrap;color:#374151;font-size:15px;line-height:1.6;background:#f9fafb;border-radius:8px;padding:14px;margin-top:8px">${esc(preview)}</div>`,
            cta: { text: 'Reply in your portal', url: OURMTG_URL },
            note: 'Equal Housing Opportunity · West Coast Capital Mortgage',
          }),
          text: `New message from your loan team:\n\n${preview}\n\nReply: ${OURMTG_URL}`,
        })
      }
    } else {
      const { data: ownerData } = await svc.auth.admin.getUserById(loanFile.owner_user_id)
      const ownerEmail = ownerData?.user?.email
      if (ownerEmail) {
        await sendPlatformEmail({
          to: ownerEmail,
          subject: `💬 Message from ${loanFile.borrower_name || 'a borrower'}`,
          html: brandedEmail({
            heading: 'A borrower sent a message',
            intro: `${esc(loanFile.borrower_name || 'A borrower')} wrote on their loan file:`,
            bodyHtml: `<div style="white-space:pre-wrap;color:#374151;font-size:15px;line-height:1.6;background:#f9fafb;border-radius:8px;padding:14px;margin-top:8px">${esc(preview)}</div>`,
            cta: { text: 'Open the file', url: OURMTG_URL },
          }),
          text: `${loanFile.borrower_name || 'A borrower'} wrote:\n\n${preview}`,
        })
      }
    }
  } catch (e) { console.warn('[portal-message-send] notify (non-fatal):', e.message) }

  return json({ ok: true, message: msg })
}
