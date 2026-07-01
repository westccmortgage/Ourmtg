// POST /.netlify/functions/lead-submit   (PUBLIC — no auth; intake happens before signup)
//
// Thin server-side proxy for the two OurMTG lead flows (borrower intake + realtor buyer
// referral). The browser posts the lead shape here; this function forwards it to GRCRM's
// lead-inbound webhook with the per-source TOKEN kept in SERVER env — so the webhook
// token is never exposed in the client bundle, and there's no cross-origin/CORS problem.
//
// Env (server-side, NOT VITE_*):
//   LEAD_INBOUND_URL    — GRCRM lead-inbound endpoint (e.g. https://grcrm.com/.netlify/functions/lead-inbound)
//   LEAD_INBOUND_TOKEN  — the lead_sources token for this OurMTG source
//
// The GRCRM webhook dedupes by email/phone, routes the lead, notifies the LO, and arms
// automations. This function does light validation, plus ONE Supabase write: when the
// payload carries a consent block (the /apply TCPA checkbox), it appends immutable rows
// to portal_consent (exact disclosure text + IP + UA) so the consent ledger required by
// spec §M actually gets written — fail-soft, never blocks the lead. It never touches
// app_state. Rate-limiting is a follow-up (front it with Netlify rate limits if abused).

import { admin, isConfigured } from './_lib/supabase.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const url = process.env.LEAD_INBOUND_URL
  const token = process.env.LEAD_INBOUND_TOKEN
  if (!url || !token) {
    return json({ ok: false, error: 'Lead intake is not configured yet.' }, 503)
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Invalid submission' }, 400)

  // Minimal validation: we need a name and a way to reach the person.
  const name = String(body.name || `${body.firstName || ''} ${body.lastName || ''}`).trim()
  if (!name) return json({ ok: false, error: 'A name is required' }, 400)
  if (!body.email && !body.phone) return json({ ok: false, error: 'An email or phone is required' }, 400)

  const target = `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  let res
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.error('[lead-submit] forward failed:', e?.message)
    return json({ ok: false, error: 'Could not reach intake service. Please try again.' }, 502)
  }

  let data = null
  try { data = await res.json() } catch { /* webhook may return non-JSON */ }
  if (!res.ok) {
    return json({ ok: false, error: data?.error || `Intake service returned ${res.status}` }, 502)
  }

  // ── Consent ledger (spec §M) — after a successful forward so retries don't
  // duplicate rows. Immutable audit: exact disclosure text + IP + UA at the moment
  // of consent. Fail-soft: a ledger hiccup must never lose the lead.
  if (body.consent && typeof body.consent === 'object' && isConfigured()) {
    try {
      const h = (n) => req.headers.get(n) || ''
      const ip = (h('x-nf-client-connection-ip') || h('x-forwarded-for').split(',')[0] || '').trim() || null
      const ua = h('user-agent').slice(0, 400) || null
      const rows = []
      const base = { portal_user: null, loan_file_id: null, ip, user_agent: ua, text_shown: String(body.consent.text || '').slice(0, 4000) || null }
      if (body.consent.sms != null) rows.push({ ...base, consent_type: 'sms', granted: !!body.consent.sms })
      if (body.consent.email != null) rows.push({ ...base, consent_type: 'email', granted: !!body.consent.email })
      if (rows.length) await admin().from('portal_consent').insert(rows)
    } catch (e) {
      console.warn('[lead-submit] consent ledger write failed (non-fatal):', e?.message)
    }
  }

  return json({ ok: true, ...(data && typeof data === 'object' ? data : {}) })
}
