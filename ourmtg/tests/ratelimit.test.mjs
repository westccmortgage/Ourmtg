// Rate-limit + fingerprint tests (Phase 1A Blocker C).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createRateLimiter, requestFingerprint, isHoneypotTripped, validatePublicPayload, HONEYPOT_FIELD,
} from '../netlify/functions/_lib/ratelimit.mjs'

function mkReq(headers = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return { headers: { get: (n) => lower[String(n).toLowerCase()] ?? null } }
}

test('limiter allows up to max then blocks within the window', () => {
  let t = 1000
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t })
  assert.equal(rl.check('k').allowed, true)
  assert.equal(rl.check('k').allowed, true)
  const blocked = rl.check('k')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterMs > 0)
})

test('keys are independent; window resets', () => {
  let t = 0
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t })
  assert.equal(rl.check('a').allowed, true)
  assert.equal(rl.check('a').allowed, false)
  assert.equal(rl.check('b').allowed, true) // different requester not blocked
  t += 1001
  assert.equal(rl.check('a').allowed, true) // reset
})

test('requestFingerprint: deterministic, differs by requester, contains no raw IP', () => {
  const salt = 'unit-salt'
  const a1 = requestFingerprint(mkReq({ 'x-nf-client-connection-ip': '1.2.3.4', 'user-agent': 'UA' }), salt)
  const a2 = requestFingerprint(mkReq({ 'x-nf-client-connection-ip': '1.2.3.4', 'user-agent': 'UA' }), salt)
  const b = requestFingerprint(mkReq({ 'x-nf-client-connection-ip': '9.9.9.9', 'user-agent': 'UA' }), salt)
  assert.equal(a1, a2)                 // deterministic for same input+salt
  assert.notEqual(a1, b)               // different IP → different key
  assert.ok(!a1.includes('1.2.3.4'))   // raw IP never present in the digest
  assert.match(a1, /^[0-9a-f]{24}$/)   // hex digest
})

test('validatePublicPayload: rejects empty and oversized, accepts normal', () => {
  assert.equal(validatePublicPayload('').ok, false)
  assert.equal(validatePublicPayload('x'.repeat(20_001)).ok, false)
  assert.equal(validatePublicPayload(JSON.stringify({ name: 'Ada', email: 'a@x.com' })).ok, true)
  assert.equal(validatePublicPayload(null).ok, false)
})

test('honeypot: filled hidden field trips; empty/absent does not', () => {
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: 'http://spam' }), true)
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '' }), false)
  assert.equal(isHoneypotTripped({ name: 'Ada' }), false)
  assert.equal(isHoneypotTripped(null), false)
})
