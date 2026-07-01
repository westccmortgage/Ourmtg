// /.netlify/functions/portal-team-set   (LO/owner-authed, Bearer JWT)
//
// The LO manages their team (processors / assistants) — the people who get internal
// access to every loan file the LO owns, via portal_team (migration 038).
//
//   GET  → { ok, members: [{ id, memberUserId, email, role, createdAt }] }
//   POST { action: 'add',    email, role? ('processor'|'assistant') }
//   POST { action: 'remove', memberUserId }
//
// SECURITY
//   • Owner-only: the caller manages THEIR OWN team (owner_user_id = caller). Team
//     members cannot add other team members (deny-by-default; no delegation in MVP).
//   • 'add' requires the member to already have a Supabase auth account (they must
//     have signed in once via magic link) — we look their auth user up by verified
//     email. This avoids minting accounts for typos and keeps identity binding real.
//   • Writes portal_team only. Never app_state.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, logAccess } from './_lib/portal.mjs'

const TEAM_ROLES = new Set(['processor', 'assistant'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Find an auth user by email via the admin API (paged; fine at this deployment's
// scale). Returns the user object or null.
async function findUserByEmail(svc, email) {
  const target = email.toLowerCase()
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error('user lookup: ' + error.message)
    const users = data?.users || []
    const hit = users.find((u) => (u.email || '').toLowerCase() === target)
    if (hit) return hit
    if (users.length < 1000) break
  }
  return null
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const svc = admin()

  // ── GET: list my team ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: rows, error } = await svc
      .from('portal_team')
      .select('id, member_user_id, role, created_at')
      .eq('owner_user_id', auth.user.id)
      .order('created_at', { ascending: true })
    if (error) return json({ ok: false, error: 'Database error' }, 500)

    const members = []
    for (const r of rows || []) {
      let email = null
      try {
        const { data: u } = await svc.auth.admin.getUserById(r.member_user_id)
        email = u?.user?.email || null
      } catch { /* leave null */ }
      members.push({ id: r.id, memberUserId: r.member_user_id, email, role: r.role, createdAt: r.created_at })
    }
    return json({ ok: true, members })
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const body = await req.json().catch(() => ({}))
  const action = String(body.action || '').trim()

  // ── POST add ──────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const email = String(body.email || '').trim().toLowerCase()
    const role = TEAM_ROLES.has(body.role) ? body.role : 'processor'
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'Invalid email' }, 400)
    if (email === (auth.user.email || '').toLowerCase()) {
      return json({ ok: false, error: 'You already own these files' }, 400)
    }

    let member
    try {
      member = await findUserByEmail(svc, email)
    } catch (e) {
      console.error('[portal-team-set]', e.message)
      return json({ ok: false, error: 'Could not look up that user' }, 500)
    }
    if (!member) {
      return json({
        ok: false,
        error: 'No account found for that email. Ask them to sign in once at the portal (magic link), then add them again.',
      }, 404)
    }

    const { error: iErr } = await svc.from('portal_team').upsert({
      owner_user_id: auth.user.id,
      member_user_id: member.id,
      role,
    }, { onConflict: 'owner_user_id,member_user_id' })
    if (iErr) {
      console.error('[portal-team-set] upsert failed:', iErr.message)
      return json({ ok: false, error: 'Could not add team member' }, 500)
    }

    await logAccess(svc, { portalUser: auth.user.id, loanFileId: null, action: 'team_add', target: email, req })
    return json({ ok: true, memberUserId: member.id, email, role })
  }

  // ── POST remove ───────────────────────────────────────────────────────────────
  if (action === 'remove') {
    const memberUserId = String(body.memberUserId || '').trim()
    if (!memberUserId) return json({ ok: false, error: 'Missing memberUserId' }, 400)
    const { error: dErr } = await svc
      .from('portal_team')
      .delete()
      .eq('owner_user_id', auth.user.id)
      .eq('member_user_id', memberUserId)
    if (dErr) return json({ ok: false, error: 'Could not remove team member' }, 500)
    await logAccess(svc, { portalUser: auth.user.id, loanFileId: null, action: 'team_remove', target: memberUserId, req })
    return json({ ok: true })
  }

  return json({ ok: false, error: 'action must be add or remove' }, 400)
}
