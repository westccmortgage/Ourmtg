// POST /.netlify/functions/portal-settings-set   (owner/admin-authed, Bearer JWT)
//
// Writes the single site_settings row (migration 039). Owner-editable site config:
// live rate, loan programs, home marketing copy. Reads are public (RLS); this is the
// only writer.
//
// Body: { data: { rate?, loanTypes?, home? } }  — replaces the settings object.
//
// SECURITY
//   • Caller must be an owner (owns >= 1 loan_file) OR their email is in
//     OURMTG_ADMIN_EMAILS (comma-separated). Site-wide settings affect every public
//     visitor, so this is gated tighter than per-file actions.
//   • Light validation/sanitization: rate is a bounded number; loanTypes a string
//     array; home fields are trimmed strings. Never touches app_state.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { authUser, json, preflight, logAccess } from './_lib/portal.mjs'

const ADMIN_EMAILS = String(process.env.OURMTG_ADMIN_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

const clampRate = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(n, 0), 25)
}
const strArr = (v, max = 20) =>
  Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, max) : null
const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max))

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const svc = admin()

  // ── Authorize: admin email, or owns at least one loan file ──────────────────
  const email = (auth.user.email || '').toLowerCase()
  let allowed = ADMIN_EMAILS.includes(email)
  if (!allowed) {
    const { data: owned } = await svc
      .from('loan_files').select('id').eq('owner_user_id', auth.user.id).limit(1)
    allowed = !!(owned && owned.length)
  }
  if (!allowed) return json({ ok: false, error: 'Not authorized to edit site settings' }, 403)

  const body = await req.json().catch(() => ({}))
  const input = body.data && typeof body.data === 'object' ? body.data : {}

  // Merge onto the existing row so a partial save never wipes other fields.
  const { data: existing } = await svc
    .from('site_settings').select('data').eq('id', 'default').maybeSingle()
  const cur = existing?.data || {}

  const next = { ...cur }
  if (input.rate !== undefined) {
    const r = clampRate(input.rate)
    if (r === null) return json({ ok: false, error: 'rate must be a number' }, 400)
    next.rate = r
  }
  if (input.loanTypes !== undefined) {
    const a = strArr(input.loanTypes)
    if (!a || !a.length) return json({ ok: false, error: 'loanTypes must be a non-empty list' }, 400)
    next.loanTypes = a
  }
  if (input.home !== undefined && typeof input.home === 'object') {
    next.home = {
      ...(cur.home || {}),
      headline: str(input.home.headline, 120) ?? (cur.home?.headline || ''),
      headlineAlt: str(input.home.headlineAlt, 120) ?? (cur.home?.headlineAlt || ''),
      sub: str(input.home.sub, 600) ?? (cur.home?.sub || ''),
    }
  }

  const { error: uErr } = await svc
    .from('site_settings')
    .upsert({ id: 'default', data: next, updated_at: new Date().toISOString() }, { onConflict: 'id' })
  if (uErr) {
    console.error('[portal-settings-set] upsert failed:', uErr.message)
    return json({ ok: false, error: 'Could not save settings' }, 500)
  }

  await logAccess(svc, { portalUser: auth.user.id, loanFileId: null, action: 'settings_updated', target: Object.keys(input).join(','), req })
  return json({ ok: true, data: next })
}
