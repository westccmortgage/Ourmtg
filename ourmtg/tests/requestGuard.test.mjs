// Phase 1C EXT-11 — request-hardening tests for the shared guard used by every new task POST.
// Covers JSON-only, size cap, empty body, prototype-pollution rejection, and the UUID / enum /
// bounded-string / timestamp validators. Pure — a fake Request is built inline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isUuid, isEnum, boundedString, isValidTimestamp, hasDangerousKeys, readJsonBody } from '../netlify/functions/_lib/requestGuard.mjs'

function fakeReq({ body = '', contentType = 'application/json' } = {}) {
  return {
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  }
}

test('isUuid accepts v4-shaped UUIDs and rejects junk', () => {
  assert.equal(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true)
  assert.equal(isUuid('not-a-uuid'), false)
  assert.equal(isUuid(''), false)
  assert.equal(isUuid(null), false)
  assert.equal(isUuid(123), false)
})

test('isEnum only allows listed string values', () => {
  assert.equal(isEnum('accept', ['accept', 'reject']), true)
  assert.equal(isEnum('delete', ['accept', 'reject']), false)
  assert.equal(isEnum(null, ['accept']), false)
})

test('boundedString trims, caps length, and null-collapses empties', () => {
  assert.equal(boundedString('  hi  ', 10), 'hi')
  assert.equal(boundedString('abcdef', 3), 'abc')
  assert.equal(boundedString('   ', 10), null)
  assert.equal(boundedString(null, 10), null)
})

test('isValidTimestamp: optional, accepts ISO, rejects garbage', () => {
  assert.equal(isValidTimestamp(null), true)      // optional
  assert.equal(isValidTimestamp(''), true)        // optional
  assert.equal(isValidTimestamp('2026-07-16T00:00:00Z'), true)
  assert.equal(isValidTimestamp('not-a-date'), false)
})

test('hasDangerousKeys detects prototype-pollution vectors at any depth', () => {
  assert.equal(hasDangerousKeys({ a: 1 }), false)
  // A real attack arrives via JSON.parse, which creates an OWN "__proto__" key (unlike a literal).
  assert.equal(hasDangerousKeys(JSON.parse('{"__proto__":{"admin":true}}')), true)
  assert.equal(hasDangerousKeys({ nested: { constructor: 1 } }), true)
  assert.equal(hasDangerousKeys({ nested: { deep: { prototype: 1 } } }), true)
})

test('readJsonBody rejects a non-JSON content type (415)', async () => {
  const r = await readJsonBody(fakeReq({ body: '{}', contentType: 'text/plain' }))
  assert.equal(r.ok, false)
  assert.equal(r.status, 415)
})

test('readJsonBody rejects an empty body (400)', async () => {
  const r = await readJsonBody(fakeReq({ body: '' }))
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('readJsonBody enforces the size cap (413)', async () => {
  const big = JSON.stringify({ x: 'a'.repeat(50_000) })
  const r = await readJsonBody(fakeReq({ body: big }), { maxBytes: 1_000 })
  assert.equal(r.ok, false)
  assert.equal(r.status, 413)
})

test('readJsonBody rejects invalid JSON (400)', async () => {
  const r = await readJsonBody(fakeReq({ body: '{ not json' }))
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('readJsonBody rejects arrays / non-object payloads (400)', async () => {
  const r = await readJsonBody(fakeReq({ body: '[1,2,3]' }))
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('readJsonBody rejects prototype-pollution payloads (400)', async () => {
  const r = await readJsonBody(fakeReq({ body: '{"a":1,"nested":{"constructor":{"x":1}}}' }))
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('readJsonBody accepts a clean JSON object', async () => {
  const r = await readJsonBody(fakeReq({ body: '{"taskId":"abc","action":"accept"}' }))
  assert.equal(r.ok, true)
  assert.equal(r.body.action, 'accept')
})
