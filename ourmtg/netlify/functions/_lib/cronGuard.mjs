// cronGuard.mjs — authorization gate for scheduled/cron functions (Phase 1A Blocker B).
//
// AUTHORIZATION MODEL
//   The ONLY thing that authorizes a cron invocation is a verified shared secret,
//   OURMTG_CRON_SECRET, presented as an HTTP Bearer credential:
//       Authorization: Bearer <OURMTG_CRON_SECRET>
//   Compared in constant time. Fail-closed: if the server secret is unset, NOTHING is
//   authorized. The secret is NEVER read from the query string and is NEVER logged.
//
//   Netlify's platform schedule header (x-netlify-event) is retained ONLY as secondary
//   CONTEXT for diagnostics (hasNetlifyScheduleSignal) — it never authorizes on its own.
//
// authorizeCron(req, env) → { ok: boolean, reason: string, scheduled: boolean }
//   reason ∈ 'ok' | 'no-secret' | 'no-bearer' | 'bad-secret'
//   scheduled = whether Netlify's schedule signal was present (context only).
//
// OPS: set OURMTG_CRON_SECRET in the environment and trigger the projector from an
// authenticated scheduler (GitHub Actions cron, uptime pinger, etc.) that sends the
// Authorization: Bearer header. Treat the secret like a password; rotate on exposure.

// Constant-time string comparison. Returns false unless both are non-empty equal-length
// strings with identical bytes (no early exit on first mismatch).
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

// Extract a Bearer token from the Authorization header. Returns '' if absent or if the
// scheme is not exactly "Bearer" (case-insensitive scheme, exact single space).
export function bearerToken(req) {
  const raw = headerGet(req, 'authorization')
  if (!raw) return ''
  const m = /^Bearer[ ]([^\s].*)$/i.exec(raw.trim())
  return m ? m[1].trim() : ''
}

// Netlify platform schedule signal — CONTEXT ONLY, never authorization.
export function hasNetlifyScheduleSignal(req) {
  return !!headerGet(req, 'x-netlify-event') || headerGet(req, 'x-nf-event') === 'schedule'
}

// Primary authorization decision. `env` defaults to process.env (inject a stub in tests).
export function authorizeCron(req, env = process.env) {
  const secret = env?.OURMTG_CRON_SECRET
  const scheduled = hasNetlifyScheduleSignal(req)
  if (!secret || String(secret).length === 0) return { ok: false, reason: 'no-secret', scheduled }
  const token = bearerToken(req)
  if (!token) return { ok: false, reason: 'no-bearer', scheduled }
  if (!timingSafeEqualStr(token, String(secret))) return { ok: false, reason: 'bad-secret', scheduled }
  return { ok: true, reason: 'ok', scheduled }
}

// rejectionLog logs header *keys* (NOT values) + the reason, so misfires are diagnosable
// without leaking the secret. Never logs the Authorization value.
export function rejectionLog(req, label, reason) {
  const keys = req?.headers?.keys ? [...req.headers.keys()].join(', ') : ''
  console.warn(`[${label}] Forbidden (${reason || 'unauthorized'}). Received header keys: ${keys}`)
}

// heartbeat records "this cron ran" in cron_heartbeat so ops can verify the scheduler gets
// past the gate. Best-effort: never throws, never affects the cron's result. NOTE:
// cron_heartbeat is NOT created by migrations 036–039 — this write fail-soft-swallows a
// missing-table error (see OURMTG_DEPLOY.md and draft 042).
export async function heartbeat(db, name, note) {
  try {
    await db.from('cron_heartbeat').upsert(
      { name, last_run: new Date().toISOString(), ...(note ? { note } : {}) },
      { onConflict: 'name' },
    )
  } catch { /* non-fatal — table may not exist yet */ }
}
