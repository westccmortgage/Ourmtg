// Phase 1C EXT-11 — shared request hardening for the new POST endpoints. Reuses Phase 1A
// conventions (JSON-only, size cap, generic client errors, PII-safe). Adds UUID/enum/date/string
// bounds and prototype-pollution rejection. Pure; no I/O beyond reading the request body.
import { isJsonContentType } from './validation.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v) }
export function isEnum(v, allowed) { return typeof v === 'string' && allowed.includes(v) }
export function boundedString(v, max) {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}
export function isValidTimestamp(v) {
  if (v == null || String(v).trim() === '') return true // optional
  const d = new Date(v)
  return !Number.isNaN(d.getTime())
}

// Recursively reject objects containing dangerous keys (prototype pollution vectors).
export function hasDangerousKeys(value, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 8) return false
  for (const k of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(k)) return true
    if (hasDangerousKeys(value[k], depth + 1)) return true
  }
  return false
}

// FCG #6: once a caller supplies a taskId to portal-doc-complete there must be NO legacy fallback.
// Decide the finalize route purely from the taskId + server flag:
//   no taskId            → 'legacy'  (existing task-less document finalize, unchanged)
//   taskId, bad UUID     → 'error' 400
//   taskId, pilot off    → 'error' 404  (never legacy — the link was requested and must be honored)
//   taskId, valid + on   → 'task'   (atomic document-finalize + task-submit)
export function docTaskLinkDecision(taskId, pilotEnabled) {
  const raw = taskId == null ? '' : String(taskId).trim()
  if (raw === '') return { mode: 'legacy' }
  if (!isUuid(raw)) return { mode: 'error', status: 400, error: 'Invalid taskId' }
  if (!pilotEnabled) return { mode: 'error', status: 404, error: 'Not available' }
  return { mode: 'task', taskId: raw }
}

// Read + validate a JSON POST body. Returns { ok, body } or { ok:false, status, error }.
// maxBytes caps the raw payload; content type must be JSON; prototype-pollution keys rejected.
export async function readJsonBody(req, { maxBytes = 32_000 } = {}) {
  if (!isJsonContentType(req)) return { ok: false, status: 415, error: 'Unsupported content type' }
  const raw = await req.text().catch(() => '')
  const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(raw, 'utf8') : raw.length
  if (bytes === 0) return { ok: false, status: 400, error: 'Empty request' }
  if (bytes > maxBytes) return { ok: false, status: 413, error: 'Request too large' }
  let body
  try { body = JSON.parse(raw) } catch { return { ok: false, status: 400, error: 'Invalid JSON' } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Invalid request' }
  if (hasDangerousKeys(body)) return { ok: false, status: 400, error: 'Invalid request' }
  return { ok: true, body }
}
