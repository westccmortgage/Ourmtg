// safelog.mjs — minimal structured, PII-aware logging helper (Phase 1A §9).
//
// Goal: server-side diagnostics without leaking secrets or borrower PII into logs, and a
// single place that guarantees PUBLIC error responses are generic (never a stack trace or
// upstream text). See docs/OURMTG-REDACTION-POLICY.md for the full policy.
//
// What is NEVER logged by these helpers: JWTs/tokens, signed URLs, service keys, raw request
// bodies, document contents, and (by convention) borrower name/email/phone/address. Callers
// pass a structured `fields` object; redact() strips obvious sensitive keys/values defensively.

const SENSITIVE_KEY = /(authorization|token|secret|password|jwt|cookie|signedurl|signed_url|service_role|apikey|api_key|bearer)/i
// Redact anything that looks like a JWT, a Bearer header, or a Supabase signed-URL token.
const SENSITIVE_VALUE = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /eyJ[A-Za-z0-9._-]{10,}/g,               // JWT-ish
  /([?&](token|signature|cron_secret)=)[^&\s]+/gi,
]

export function redact(value, depth = 0) {
  if (value == null || depth > 4) return value
  if (typeof value === 'string') {
    let s = value
    for (const re of SENSITIVE_VALUE) s = s.replace(re, '[redacted]')
    return s.length > 500 ? s.slice(0, 500) + '…' : s
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

// Structured server log. `event` is a stable dotted name; `fields` is redacted before output.
// severity ∈ 'info'|'warn'|'error'. Never throws.
export function logEvent(event, { severity = 'info', requestId, ...fields } = {}) {
  try {
    const line = { event, severity, ...(requestId ? { requestId } : {}), ...redact(fields) }
    const s = JSON.stringify(line)
    if (severity === 'error') console.error(s)
    else if (severity === 'warn') console.warn(s)
    else console.log(s)
  } catch { /* logging must never break the handler */ }
}

// Build a GENERIC public error body. Detail is logged server-side, never returned. Optionally
// include a requestId so a user can quote it to support without exposing internals.
export function publicError(message = 'Something went wrong. Please try again.', requestId) {
  return { ok: false, error: message, ...(requestId ? { requestId } : {}) }
}
