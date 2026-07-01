// POST /.netlify/functions/portal-invite-accept   (portal-user-authed, Bearer JWT)
//
// Half 2 of "mint/grant portal_access". After the invitee signs in via magic link,
// the OurMTG app calls this with the invite token. It validates the token and MINTS
// the portal_access grant + upserts the portal_users identity.
//
// Body: { token }
//
// SECURITY
//   • Token must exist, be unused, and be unexpired.
//   • IDENTITY BINDING: the accepting user's VERIFIED email (or phone, for phone-only
//     invites) must match the invite target — a leaked link cannot be redeemed by a
//     different logged-in account. Mirrors the team-invite verified-email rule.
//   • Single-use: accepted_at is stamped; a second accept is rejected.
//   • Never touches app_state. Writes portal_users + portal_access + an audit row.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, logAccess } from './_lib/portal.mjs'

const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^1/, '')

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '').trim()
  if (!/^[0-9a-f]{32}$/i.test(token)) return json({ ok: false, error: 'Invalid token' }, 400)

  const svc = admin()

  const { data: invite, error: iErr } = await svc
    .from('portal_invites')
    .select('id, owner_user_id, loan_file_id, role, email, phone, name, expires_at, accepted_at')
    .eq('token', token)
    .maybeSingle()
  if (iErr) return json({ ok: false, error: 'Database error' }, 500)
  if (!invite) return json({ ok: false, error: 'Invite not found' }, 404)
  if (invite.accepted_at) return json({ ok: false, error: 'This invite was already used' }, 409)
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return json({ ok: false, error: 'This invite has expired' }, 410)
  }

  // ── Identity binding ────────────────────────────────────────────────────────
  const user = auth.user
  const userEmail = (user.email || '').toLowerCase()
  const emailVerified = !!(user.email_confirmed_at || user.confirmed_at)
  if (invite.email) {
    if (!emailVerified || userEmail !== invite.email.toLowerCase()) {
      return json({ ok: false, error: 'This invite was issued to a different email' }, 403)
    }
  } else if (invite.phone) {
    if (normPhone(user.phone) !== normPhone(invite.phone)) {
      return json({ ok: false, error: 'This invite was issued to a different phone' }, 403)
    }
  }

  // ── Upsert portal identity ──────────────────────────────────────────────────
  const { error: puErr } = await svc.from('portal_users').upsert({
    id: user.id,
    role: invite.role,
    full_name: invite.name || user.user_metadata?.full_name || null,
    email: userEmail || invite.email || null,
    phone: user.phone || invite.phone || null,
  }, { onConflict: 'id' })
  if (puErr) {
    console.error('[portal-invite-accept] portal_users upsert:', puErr.message)
    return json({ ok: false, error: 'Could not create your profile' }, 500)
  }

  // ── Mint the grant (idempotent via unique(portal_user, loan_file_id)) ────────
  const { error: paErr } = await svc.from('portal_access').upsert({
    portal_user: user.id,
    loan_file_id: invite.loan_file_id,
    visibility: invite.role,
  }, { onConflict: 'portal_user,loan_file_id' })
  if (paErr) {
    console.error('[portal-invite-accept] portal_access upsert:', paErr.message)
    return json({ ok: false, error: 'Could not grant access' }, 500)
  }

  // ── Single-use: stamp accepted ──────────────────────────────────────────────
  await svc.from('portal_invites')
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq('id', invite.id).is('accepted_at', null)

  await logAccess(svc, {
    portalUser: user.id, loanFileId: invite.loan_file_id, action: 'invite_accepted', target: invite.role, req,
  })

  return json({ ok: true, loanFileId: invite.loan_file_id, role: invite.role })
}
