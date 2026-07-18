// ratelimit.mjs — dependency-free, in-memory sliding-window rate limiter + abuse helpers
// for PUBLIC endpoints (Phase 1A #3).
//
// SCOPE / HONESTY: serverless functions are stateless across cold starts and may run on
// multiple instances, so an in-process limiter is BEST-EFFORT — it throttles bursts that
// hit the same warm instance and provides a real speed bump against naive abuse, but it is
// not a globally-consistent limiter. A durable cross-instance limiter needs a shared store
// (e.g. a Postgres/Upstash table); that is deferred because Phase 1A must not add or apply
// production tables. The limiter is written with an injectable clock + store so it is fully
// unit-testable and can be swapped for a durable backend later without touching callers.

// Create a fixed-window limiter. `now` and `store` are injectable for tests.
//   windowMs — the window length; max — allowed hits per key per window.
// Returns { check(key) → { allowed, remaining, retryAfterMs } }.
export function createRateLimiter({ windowMs = 60_000, max = 5, now = () => Date.now(), store = new Map() } = {}) {
  function check(key) {
    const k = String(key || 'anon')
    const t = now()
    const rec = store.get(k)
    if (!rec || t >= rec.resetAt) {
      store.set(k, { count: 1, resetAt: t + windowMs })
      return { allowed: true, remaining: max - 1, retryAfterMs: 0 }
    }
    if (rec.count >= max) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, rec.resetAt - t) }
    }
    rec.count += 1
    return { allowed: true, remaining: max - rec.count, retryAfterMs: 0 }
  }
  // Opportunistic pruning so the Map can't grow unbounded on a long-lived warm instance.
  function prune() {
    const t = now()
    for (const [k, rec] of store) if (t >= rec.resetAt) store.delete(k)
  }
  return { check, prune, _store: store }
}

// A module-level limiter shared across invocations on the same warm instance.
let _shared = null
export function sharedLimiter(opts) {
  if (!_shared) _shared = createRateLimiter(opts)
  return _shared
}

// Extract a best-effort client IP from platform headers. Used ONLY as an input to the
// privacy-conscious fingerprint below — never persisted or logged raw.
export function clientKey(req) {
  const h = (n) => (req?.headers?.get ? req.headers.get(n) : req?.headers?.[n]) || ''
  const ip = (h('x-nf-client-connection-ip') || h('x-forwarded-for').split(',')[0] || '').trim()
  return ip || 'unknown'
}

// Privacy-conscious request fingerprint for rate limiting: a salted SHA-256 of IP + UA,
// truncated. The RAW IP is never stored (only this one-way digest lives in the ephemeral,
// short-TTL limiter map). A per-deploy salt (OURMTG_FINGERPRINT_SALT) makes digests
// non-reversible across deploys. Deterministic for a given (ip, ua, salt) so the limiter
// groups the same requester; different requesters get different keys.
import { createHash } from 'node:crypto'
export function requestFingerprint(req, salt = process.env.OURMTG_FINGERPRINT_SALT || 'ourmtg-default-salt') {
  const h = (n) => (req?.headers?.get ? req.headers.get(n) : req?.headers?.[n]) || ''
  const ip = clientKey(req)
  const ua = String(h('user-agent') || '').slice(0, 200)
  return createHash('sha256').update(`${salt}\n${ip}\n${ua}`).digest('hex').slice(0, 24)
}

// Honeypot check: a hidden form field real users never fill. If present and non-empty,
// the submission is almost certainly a bot. Field name kept unlikely-to-collide.
export const HONEYPOT_FIELD = 'company_website'
export function isHoneypotTripped(body) {
  return !!(body && typeof body === 'object' && String(body[HONEYPOT_FIELD] || '').trim())
}

// Shape/size guardrails for a public JSON body. Returns { ok, error } — pure.
//   maxBytes caps the raw payload; a body over the cap is rejected before parsing work.
export function validatePublicPayload(raw, { maxBytes = 20_000 } = {}) {
  if (typeof raw !== 'string') return { ok: false, error: 'Invalid submission' }
  // Byte length (not char length) — multibyte-safe.
  const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(raw, 'utf8') : raw.length
  if (bytes === 0) return { ok: false, error: 'Empty submission' }
  if (bytes > maxBytes) return { ok: false, error: 'Submission too large' }
  return { ok: true }
}
