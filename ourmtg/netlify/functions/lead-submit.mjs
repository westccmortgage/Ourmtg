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
// spec §M actually gets written — fail-soft, never blocks the lead. It never touches app_state.
//
// ABUSE PROTECTION (Phase 1A Blocker C): JSON-only content type, method allowlist, raw
// payload-size cap, honeypot, and a rate limit keyed by a PRIVACY-CONSCIOUS request
// FINGERPRINT (salted hash of IP+UA — the raw IP is never persisted for rate limiting; it
// lives only inside the short-TTL in-process limiter map as a one-way digest). The limiter
// is BEST-EFFORT / per warm instance — see _lib/ratelimit.mjs; it does not claim
// cross-instance protection. Public error responses are generic; detail is server-side only.
// NOTE: the TCPA consent ledger below deliberately retains raw IP+UA (a legal audit
// requirement, spec §M) — that is a distinct, intentional record, not rate-limit data.
// Tunables: LEAD_RATE_MAX (default 5), LEAD_RATE_WINDOW_MS (default 60000).

import { admin, isConfigured } from './_lib/supabase.mjs'
import { sharedLimiter, requestFingerprint, isHoneypotTripped, validatePublicPayload } from './_lib/ratelimit.mjs'
import { isJsonContentType, normalizeEmail, isValidEmail, normalizePhone, isValidPhone } from './_lib/validation.mjs'

const RATE_MAX = Number(process.env.LEAD_RATE_MAX || 5)
const RATE_WINDOW_MS = Number(process.env.LEAD_RATE_WINDOW_MS || 60_000)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extraHeaders } })

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  // Reject unexpected content types before touching the body.
  if (!isJsonContentType(req)) return json({ ok: false, error: 'Unsupported content type' }, 415)

  // ── Rate limit by privacy-conscious fingerprint (salted hash of IP+UA — no raw IP
  //    stored). Best-effort, per warm instance. Fail-OPEN if the limiter throws so a
  //    limiter bug never blocks a legitimate borrower. ──────────────────────────────────
  try {
    const limiter = sharedLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX })
    const verdict = limiter.check(requestFingerprint(req))
    if (!verdict.allowed) {
      return json(
        { ok: false, error: 'Too many submissions. Please wait a moment and try again.' },
        429,
        { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) },
      )
    }
  } catch (e) {
    console.warn('[lead-submit] rate limiter error (failing open):', e?.message)
  }

  const url = process.env.LEAD_INBOUND_URL
  const token = process.env.LEAD_INBOUND_TOKEN
  if (!url || !token) {
    return json({ ok: false, error: 'Lead intake is not configured yet.' }, 503)
  }

  // Read raw text first so we can enforce a size cap before doing any parse work.
  const raw = await req.text().catch(() => '')
  const sizeCheck = validatePublicPayload(raw)
  if (!sizeCheck.ok) return json({ ok: false, error: sizeCheck.error }, 400)

  let body = null
  try { body = JSON.parse(raw) } catch { body = null }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Invalid submission' }, 400)

  // Honeypot: bots fill hidden fields; humans never see them. Respond 200 without
  // forwarding so we neither create a lead nor tip off the bot that it was caught.
  if (isHoneypotTripped(body)) return json({ ok: true, accepted: true })

  // Minimal validation: we need a name and a way to reach the person.
  const name = String(body.name || `${body.firstName || ''} ${body.lastName || ''}`).trim()
  if (!name) return json({ ok: false, error: 'A name is required' }, 400)
  if (!body.email && !body.phone) return json({ ok: false, error: 'An email or phone is required' }, 400)

  // Normalize + validate contact fields. Reject malformed values (never silently forward
  // garbage), then forward the NORMALIZED values so GRCRM dedupe/routing gets clean input.
  if (body.email != null && String(body.email).trim() !== '') {
    if (!isValidEmail(body.email)) return json({ ok: false, error: 'Please enter a valid email address' }, 400)
    body.email = normalizeEmail(body.email)
  }
  if (body.phone != null && String(body.phone).trim() !== '') {
    if (!isValidPhone(body.phone)) return json({ ok: false, error: 'Please enter a valid phone number' }, 400)
    body.phone = normalizePhone(body.phone)
  }

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
    // Log upstream detail server-side; return a GENERIC message (never leak upstream text).
    console.error('[lead-submit] upstream non-OK:', res.status, typeof data?.error === 'string' ? data.error : '')
    return json({ ok: false, error: 'Could not submit right now. Please try again.' }, 502)
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
