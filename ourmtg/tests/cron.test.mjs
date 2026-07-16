// Cron authorization tests (Phase 1A Blocker B). Bearer secret is the sole authorization.
import test from 'node:test'
import assert from 'node:assert/strict'

import { authorizeCron, timingSafeEqualStr, bearerToken, hasNetlifyScheduleSignal } from '../netlify/functions/_lib/cronGuard.mjs'

function mkReq(headers = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return { headers: { get: (n) => lower[String(n).toLowerCase()] ?? null } }
}
const SECRET = 's3cret-value-123'

test('timingSafeEqualStr: equal non-empty match; length/empty/diff do not', () => {
  assert.equal(timingSafeEqualStr(SECRET, SECRET), true)
  assert.equal(timingSafeEqualStr(SECRET, SECRET + 'x'), false)
  assert.equal(timingSafeEqualStr('', ''), false)
  assert.equal(timingSafeEqualStr('a', undefined), false)
})

test('bearerToken parses only the Bearer scheme', () => {
  assert.equal(bearerToken(mkReq({ authorization: `Bearer ${SECRET}` })), SECRET)
  assert.equal(bearerToken(mkReq({ authorization: `bearer ${SECRET}` })), SECRET) // scheme case-insensitive
  assert.equal(bearerToken(mkReq({ authorization: `Basic ${SECRET}` })), '')      // wrong scheme
  assert.equal(bearerToken(mkReq({})), '')
})

// (1) no header → denied
test('no Authorization header → denied', () => {
  assert.deepEqual(authorizeCron(mkReq({}), { OURMTG_CRON_SECRET: SECRET }), { ok: false, reason: 'no-bearer', scheduled: false })
})

// (2) wrong scheme → denied
test('wrong auth scheme → denied (no-bearer)', () => {
  const r = authorizeCron(mkReq({ authorization: `Basic ${SECRET}` }), { OURMTG_CRON_SECRET: SECRET })
  assert.equal(r.ok, false); assert.equal(r.reason, 'no-bearer')
})

// (3) wrong secret → denied
test('wrong secret → denied (bad-secret)', () => {
  const r = authorizeCron(mkReq({ authorization: 'Bearer nope' }), { OURMTG_CRON_SECRET: SECRET })
  assert.equal(r.ok, false); assert.equal(r.reason, 'bad-secret')
})

// (4) correct secret → allowed
test('correct Bearer secret → allowed', () => {
  const r = authorizeCron(mkReq({ authorization: `Bearer ${SECRET}` }), { OURMTG_CRON_SECRET: SECRET })
  assert.equal(r.ok, true); assert.equal(r.reason, 'ok')
})

// (5) missing server secret → fail closed
test('server secret unset → fail closed (no-secret) even with a Bearer', () => {
  const r = authorizeCron(mkReq({ authorization: `Bearer ${SECRET}` }), {})
  assert.equal(r.ok, false); assert.equal(r.reason, 'no-secret')
})

// (6) spoofed platform header without secret → denied
test('Netlify schedule header alone never authorizes', () => {
  const r = authorizeCron(mkReq({ 'x-netlify-event': 'schedule' }), { OURMTG_CRON_SECRET: SECRET })
  assert.equal(r.ok, false)
  assert.equal(r.scheduled, true) // header noted as context only
})

test('hasNetlifyScheduleSignal is context only', () => {
  assert.equal(hasNetlifyScheduleSignal(mkReq({ 'x-netlify-event': 'schedule' })), true)
  assert.equal(hasNetlifyScheduleSignal(mkReq({})), false)
})

// (7) secret never appears in the authorization decision object (no echo/leak)
test('authorization result never contains the secret value', () => {
  const r = authorizeCron(mkReq({ authorization: `Bearer ${SECRET}` }), { OURMTG_CRON_SECRET: SECRET })
  assert.ok(!JSON.stringify(r).includes(SECRET))
})
