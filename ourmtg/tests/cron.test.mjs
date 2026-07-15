// Cron authorization contract tests (Phase 1A #4).
// Verifies verified-secret is the default and header-trust is opt-in only. Run: npm test
import test from 'node:test'
import assert from 'node:assert/strict'

import { authorizeCron, timingSafeEqualStr, hasNetlifyScheduleSignal } from '../netlify/functions/_lib/cronGuard.mjs'

// Minimal Request-like stub: headers.get + url.
function mkReq(headers = {}, url = 'http://fn/.netlify/functions/sync-loan-file') {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return { headers: { get: (n) => lower[String(n).toLowerCase()] ?? null }, url }
}

test('timingSafeEqualStr: equal non-empty strings match; others do not', () => {
  assert.equal(timingSafeEqualStr('s3cret', 's3cret'), true)
  assert.equal(timingSafeEqualStr('s3cret', 's3creT'), false)
  assert.equal(timingSafeEqualStr('ab', 'abc'), false) // length differs
  assert.equal(timingSafeEqualStr('', ''), false)      // empty never matches
  assert.equal(timingSafeEqualStr('x', undefined), false)
})

test('valid secret via header authorizes (reason: secret)', () => {
  const r = authorizeCron(mkReq({ 'x-cron-secret': 's3cret' }), { CRON_SECRET: 's3cret' })
  assert.deepEqual(r, { ok: true, reason: 'secret' })
})

test('valid secret via ?cron_secret query authorizes', () => {
  const r = authorizeCron(mkReq({}, 'http://fn/x?cron_secret=s3cret'), { CRON_SECRET: 's3cret' })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'secret')
})

test('wrong secret is denied (reason: bad-secret)', () => {
  const r = authorizeCron(mkReq({ 'x-cron-secret': 'nope' }), { CRON_SECRET: 's3cret' })
  assert.deepEqual(r, { ok: false, reason: 'bad-secret' })
})

test('secret configured but none presented is denied (reason: not-scheduled)', () => {
  const r = authorizeCron(mkReq({}), { CRON_SECRET: 's3cret' })
  assert.deepEqual(r, { ok: false, reason: 'not-scheduled' })
})

test('NO trust of x-netlify-event header alone when opt-in is off', () => {
  // This is the core Phase 1A #4 fix: header-trust is not the default.
  const r = authorizeCron(mkReq({ 'x-netlify-event': 'schedule' }), { CRON_SECRET: 's3cret' })
  assert.equal(r.ok, false)
})

test('Netlify schedule header authorizes ONLY with explicit opt-in', () => {
  const optIn = { CRON_ALLOW_NETLIFY_SCHEDULE: 'true' }
  assert.equal(authorizeCron(mkReq({ 'x-netlify-event': 'schedule' }), optIn).ok, true)
  assert.equal(authorizeCron(mkReq({ 'x-netlify-event': 'schedule' }), optIn).reason, 'netlify-schedule-optin')
  // Opt-in off (default) → the same header does not authorize.
  assert.equal(authorizeCron(mkReq({ 'x-netlify-event': 'schedule' }), { CRON_ALLOW_NETLIFY_SCHEDULE: 'false' }).ok, false)
})

test('no secret and no opt-in is a fail-closed misconfiguration (reason: no-secret)', () => {
  const r = authorizeCron(mkReq({ 'x-netlify-event': 'schedule' }), {})
  assert.deepEqual(r, { ok: false, reason: 'no-secret' })
})

test('hasNetlifyScheduleSignal detects both header markers', () => {
  assert.equal(hasNetlifyScheduleSignal(mkReq({ 'x-netlify-event': 'schedule' })), true)
  assert.equal(hasNetlifyScheduleSignal(mkReq({ 'x-nf-event': 'schedule' })), true)
  assert.equal(hasNetlifyScheduleSignal(mkReq({})), false)
})
