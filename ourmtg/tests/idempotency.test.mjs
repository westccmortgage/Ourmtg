// Phase 1C EXT-8 — idempotency helpers. Key format/length validation (no random fallback allowed),
// canonical (key-order-independent) JSON, and a stable sha256 request hash that differs when the
// MATERIAL payload differs. Pure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidIdempotencyKey, canonicalJson, requestHash } from '../netlify/functions/_lib/idempotency.mjs'

test('isValidIdempotencyKey enforces charset + length bounds', () => {
  assert.equal(isValidIdempotencyKey('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true)
  assert.equal(isValidIdempotencyKey('create:file:tab-1'), true)
  assert.equal(isValidIdempotencyKey('short'), false)          // < 8 chars
  assert.equal(isValidIdempotencyKey(''), false)
  assert.equal(isValidIdempotencyKey(null), false)
  assert.equal(isValidIdempotencyKey('has space!!'), false)    // illegal chars
  assert.equal(isValidIdempotencyKey('a'.repeat(201)), false)  // > 200 chars
})

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
  assert.equal(canonicalJson({ x: { p: 1, q: 2 } }), canonicalJson({ x: { q: 2, p: 1 } }))
})

test('canonicalJson preserves array order (arrays are ordered, objects are not)', () => {
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }))
})

test('requestHash: same material payload → same hash regardless of key order', () => {
  const h1 = requestHash({ title: 'W-2', loanFileId: 'f', actor: 'lo' })
  const h2 = requestHash({ actor: 'lo', loanFileId: 'f', title: 'W-2' })
  assert.equal(h1, h2)
  assert.match(h1, /^[0-9a-f]{64}$/) // sha256 hex
})

test('requestHash: different material payload → different hash (drives idempotency_conflict)', () => {
  const h1 = requestHash({ title: 'Upload W-2', loanFileId: 'f' })
  const h2 = requestHash({ title: 'Upload paystubs', loanFileId: 'f' })
  assert.notEqual(h1, h2)
})

test('canonicalJson tolerates cycles without throwing', () => {
  const a = { name: 'x' }; a.self = a
  assert.doesNotThrow(() => canonicalJson(a))
})
