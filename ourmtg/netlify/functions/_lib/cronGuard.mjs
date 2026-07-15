// cronGuard.mjs — invocation gate for Netlify cron functions.
//
// Phase 1A #4: header-trust is no longer the ONLY authorization. The default posture is a
// VERIFIED SHARED SECRET (CRON_SECRET), compared in constant time. Netlify's platform
// schedule header is accepted ONLY when the operator explicitly opts in via
// CRON_ALLOW_NETLIFY_SCHEDULE=true — so a spoofed x-netlify-event header, on its own, no
// longer authorizes anything unless that opt-in is deliberately set.
//
// authorizeCron(req, env) → { ok: boolean, reason: string }
//   reason ∈ 'secret' | 'netlify-schedule-optin' | 'no-secret' | 'bad-secret' | 'not-scheduled'
//
// RECOMMENDED OPS SETUP (verified-secret, platform-independent):
//   Set CRON_SECRET in the Netlify environment and trigger the projector from an
//   authenticated scheduler (e.g. a GitHub Actions cron, an uptime pinger, or Netlify's
//   scheduled function calling itself) that sends:
//       x-cron-secret: <CRON_SECRET>            (or ?cron_secret=<CRON_SECRET>)
//   Only if you intend to rely on Netlify's built-in scheduler AND accept its header as
//   proof of origin, additionally set CRON_ALLOW_NETLIFY_SCHEDULE=true. Never expose
//   CRON_SECRET publicly — treat it like a password.

// Constant-time string comparison (avoids leaking secret length/prefix via timing).
// Returns false unless both are non-empty strings of equal length with equal bytes.
export function timingSafeEqualStr(a, b) {
  const x = typeof a === 'string' ? a : ''
  const y = typeof b === 'string' ? b : ''
  if (x.length === 0 || y.length === 0) return false
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

function headerGet(req, name) {
  if (!req || !req.headers) return ''
  if (typeof req.headers.get === 'function') return req.headers.get(name) || ''
  return req.headers[name] || ''
}

function presentedSecret(req) {
  const h = headerGet(req, 'x-cron-secret')
  if (h) return h
  // Also accept ?cron_secret= for schedulers that can't set headers.
  try {
    const u = new URL(req.url || 'http://x/')
    return u.searchParams.get('cron_secret') || ''
  } catch { return '' }
}

// True if this looks like Netlify's platform scheduled invocation (header marker).
// NOTE: this signal alone is NOT trusted unless CRON_ALLOW_NETLIFY_SCHEDULE=true.
export function hasNetlifyScheduleSignal(req) {
  return !!headerGet(req, 'x-netlify-event') || headerGet(req, 'x-nf-event') === 'schedule'
}

// Primary authorization decision. `env` defaults to process.env so callers can pass a
// stub in tests.
export function authorizeCron(req, env = process.env) {
  const secret = env?.CRON_SECRET
  const allowSchedule = String(env?.CRON_ALLOW_NETLIFY_SCHEDULE || '').toLowerCase() === 'true'

  // 1) Verified shared secret — the default, preferred path.
  if (secret && secret.length > 0) {
    if (timingSafeEqualStr(presentedSecret(req), secret)) return { ok: true, reason: 'secret' }
  }
  // 2) Explicit operator opt-in to trust Netlify's platform schedule header.
  if (allowSchedule && hasNetlifyScheduleSignal(req)) {
    return { ok: true, reason: 'netlify-schedule-optin' }
  }
  // 3) Denied. Distinguish misconfiguration (no secret, no opt-in) from a bad attempt.
  if (!secret && !allowSchedule) return { ok: false, reason: 'no-secret' }
  if (secret && presentedSecret(req)) return { ok: false, reason: 'bad-secret' }
  return { ok: false, reason: 'not-scheduled' }
}

// Backward-compatible boolean wrapper (kept so existing imports keep working). Prefer
// authorizeCron for the reason string.
export function isScheduledInvocation(req) {
  return authorizeCron(req).ok
}

// rejectionLog logs the header *keys* (NOT values) of a rejected request plus the reason,
// so misfires are diagnosable in function logs without leaking secrets.
export function rejectionLog(req, label, reason) {
  const keys = req?.headers?.keys ? [...req.headers.keys()].join(', ') : ''
  console.warn(`[${label}] Forbidden (${reason || 'unauthorized'}). Received header keys: ${keys}`)
}

// heartbeat records "this cron ran" in cron_heartbeat so ops can verify the scheduler
// actually gets past the gate (vs silently 403ing). Best-effort: never throws.
export async function heartbeat(db, name, note) {
  try {
    await db.from('cron_heartbeat').upsert(
      { name, last_run: new Date().toISOString(), ...(note ? { note } : {}) },
      { onConflict: 'name' },
    )
  } catch { /* non-fatal */ }
}
