// POST /.netlify/functions/portal-invite-create   (LO/owner-authed, Bearer JWT)
//
// Mints a tokenized, expiring invite that GRANTS a borrower / co-borrower / realtor
// access to ONE loan_file. This is half 1 of "mint/grant portal_access" — the actual
// portal_access row is created when the invitee accepts (portal-invite-accept).
//
// Body: { loanFileId, role: 'borrower'|'coborrower'|'realtor', email?, phone?, name?, expiresInDays? }
//
// SECURITY
//   • Caller must be the loan_file's OWNER (caller.id === loan_file.owner_user_id).
//     (Team-member invites are a later enhancement; deny-by-default for MVP.)
//   • Token is a 32-hex server secret. Default expiry 14 days.
//   • Never reads or writes app_state. Writes only portal_invites + an audit row.
//   • Sends the invite by email (platform mailer) when an email is provided; the link
//     is always returned so the LO can deliver it another way.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, resolveAccess, isInternal, logAccess, randomToken } from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'

const ROLES = new Set(['borrower', 'coborrower', 'realtor', 'escrow', 'title'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  const role = String(body.role || '').trim()
  const email = body.email ? String(body.email).trim().toLowerCase() : null
  const phone = body.phone ? String(body.phone).trim() : null
  const name = body.name ? String(body.name).trim().slice(0, 120) : null
  const expiresInDays = Math.min(Math.max(parseInt(body.expiresInDays, 10) || 14, 1), 60)

  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)
  if (!ROLES.has(role)) return json({ ok: false, error: 'Invalid role' }, 400)
  if (!email && !phone) return json({ ok: false, error: 'Provide an email or phone to invite' }, 400)
  if (email && !EMAIL_RE.test(email)) return json({ ok: false, error: 'Invalid email' }, 400)

  const svc = admin()

  // Load the loan file and authorize: caller must be internal (owner or their team).
  const { data: loanFile, error: lfErr } = await svc
    .from('loan_files').select('id, owner_user_id, borrower_name').eq('id', loanFileId).maybeSingle()
  if (lfErr) return json({ ok: false, error: 'Database error' }, 500)
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  const access = await resolveAccess(svc, auth.user.id, loanFile).catch(() => null)
  if (!isInternal(access)) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  // Create the invite.
  const token = await randomToken(16) // 32 hex chars
  const expiresAt = new Date(Date.now() + expiresInDays * 86400_000).toISOString()

  const { data: invite, error: insErr } = await svc
    .from('portal_invites')
    .insert({
      owner_user_id: loanFile.owner_user_id,
      loan_file_id: loanFileId,
      role, token, email, phone, name,
      expires_at: expiresAt,
      created_by: auth.user.id,
    })
    .select('id')
    .maybeSingle()
  if (insErr) {
    console.error('[portal-invite-create] insert failed:', insErr.message)
    return json({ ok: false, error: 'Could not create invite' }, 500)
  }

  await logAccess(svc, {
    portalUser: null, loanFileId, action: 'invite_created', target: email || phone, req,
  })

  const inviteUrl = `${OURMTG_URL}/invite?token=${token}`

  // Best-effort email delivery (fail-soft — the link is returned regardless).
  let emailed = false
  if (email) {
    const roleWord = role === 'realtor' ? 'track your buyer’s loan'
      : (role === 'escrow' || role === 'title') ? 'track this transaction’s milestones'
      : 'start and track your loan'
    const html = brandedEmail({
      heading: 'Your secure loan portal is ready',
      intro: `You’ve been invited to ${esc(roleWord)} securely with West Coast Capital Mortgage.`,
      bodyHtml: '<p style="color:#374151;font-size:15px;line-height:1.6;margin:0">Tap below to sign in — no password needed. Your link is private to you.</p>',
      cta: { text: 'Open your portal', url: inviteUrl },
      note: `This invitation expires in ${expiresInDays} days. Equal Housing Opportunity.`,
    })
    const r = await sendPlatformEmail({
      to: email,
      subject: 'Your secure loan portal — West Coast Capital Mortgage',
      html,
      text: `You've been invited to your secure loan portal.\nOpen: ${inviteUrl}\nThis link expires in ${expiresInDays} days.`,
    })
    emailed = !!r.ok
  }

  return json({ ok: true, inviteId: invite.id, inviteUrl, role, expiresAt, emailed })
}
