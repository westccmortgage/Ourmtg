// Rate-limit & public-endpoint abuse-protection tests (Phase 1A #3/#5). Run: npm test
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createRateLimiter, clientKey, isHoneypotTripped, validatePublicPayload, HONEYPOT_FIELD,
} from '../netlify/functions/_lib/ratelimit.mjs'

test('limiter allows up to max, then blocks within the window', () => {
  let t = 1000
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t })
  assert.equal(rl.check('ip1').allowed, true)  // 1
  assert.equal(rl.check('ip1').allowed, true)  // 2
  const blocked = rl.check('ip1')              // 3 → blocked
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterMs > 0)
})

test('keys are independent', () => {
  let t = 0
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t })
  assert.equal(rl.check('a').allowed, true)
  assert.equal(rl.check('a').allowed, false)
  assert.equal(rl.check('b').allowed, true) // different key unaffected
})

test('window resets after windowMs', () => {
  let t = 0
  const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t })
  assert.equal(rl.check('a').allowed, true)
  assert.equal(rl.check('a').allowed, false)
  t += 1001 // advance past the window
  assert.equal(rl.check('a').allowed, true)
})

test('validatePublicPayload: rejects empty and oversized, accepts normal', () => {
  assert.equal(validatePublicPayload('').ok, false)
  assert.equal(validatePublicPayload('x'.repeat(20_001)).ok, false)
  assert.equal(validatePublicPayload(JSON.stringify({ name: 'Ada', email: 'a@x.com' })).ok, true)
  assert.equal(validatePublicPayload(null).ok, false)
})

test('honeypot: a filled hidden field trips; empty/absent does not', () => {
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: 'http://spam' }), true)
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: '' }), false)
  assert.equal(isHoneypotTripped({ name: 'Ada' }), false)
  assert.equal(isHoneypotTripped(null), false)
})

test('clientKey extracts an IP from platform headers, falls back to unknown', () => {
  const mk = (h) => ({ headers: { get: (n) => h[n.toLowerCase()] ?? null } })
  assert.equal(clientKey(mk({ 'x-nf-client-connection-ip': '1.2.3.4' })), '1.2.3.4')
  assert.equal(clientKey(mk({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })), '9.9.9.9')
  assert.equal(clientKey(mk({})), 'unknown')
})
