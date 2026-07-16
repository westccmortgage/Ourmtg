// validation.mjs — pure input normalization/validation for public submissions (Phase 1A
// Blocker C). No I/O, no PII logging — safe to unit-test.

// Accept only JSON request bodies on public POST endpoints. Tolerant of a charset suffix
// and missing header casing. Returns true for application/json (optionally +something).
export function isJsonContentType(req) {
  const raw = (req?.headers?.get ? req.headers.get('content-type') : req?.headers?.['content-type']) || ''
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(String(raw).trim())
}

// Normalize an email to a comparable form: trim + lowercase. Does not validate.
export function normalizeEmail(v) {
  return String(v ?? '').trim().toLowerCase()
}

// Conservative email shape check (not RFC-exhaustive; rejects obvious garbage/injection).
// One @, non-empty local part, a dotted domain, no whitespace/control chars.
export function isValidEmail(v) {
  const e = normalizeEmail(v)
  if (!e || e.length > 254) return false
  if (/[\s<>]/.test(e)) return false
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)
}

// Normalize a phone to digits, preserving a single leading '+'. Strips spaces, dashes,
// parens, dots. Returns '' for empty input.
export function normalizePhone(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const plus = s.startsWith('+') ? '+' : ''
  return plus + s.replace(/[^\d]/g, '')
}

// Valid if it normalizes to 10–15 digits (E.164-ish, generous for US + intl).
export function isValidPhone(v) {
  const n = normalizePhone(v).replace(/^\+/, '')
  return /^\d{10,15}$/.test(n)
}
