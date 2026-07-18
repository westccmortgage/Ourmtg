// Phase 1C EXT-8 — idempotency helpers. A mandatory key (no random fallback) plus a canonical
// hash of the MATERIAL payload so: same key + same payload → original result; same key +
// different payload → idempotency_conflict (enforced in the RPC by comparing request_hash). Pure.
import { createHash } from 'node:crypto'

const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/

export function isValidIdempotencyKey(k) {
  return typeof k === 'string' && KEY_RE.test(k)
}

// Deterministic JSON with recursively sorted object keys (arrays keep order). Undefined dropped.
export function canonicalJson(value) {
  const seen = new WeakSet()
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v === undefined ? null : v
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return v.map(norm)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
    return out
  }
  return JSON.stringify(norm(value))
}

// sha256 hex of the canonical material payload — the value stored as loan_events.request_hash.
export function requestHash(materialPayload) {
  return createHash('sha256').update(canonicalJson(materialPayload)).digest('hex')
}
