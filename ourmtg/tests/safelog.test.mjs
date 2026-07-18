// Safe-logging / public-error redaction tests (Phase 1A §9).
import test from 'node:test'
import assert from 'node:assert/strict'

import { redact, publicError } from '../netlify/functions/_lib/safelog.mjs'

test('redact: strips sensitive keys', () => {
  const out = redact({ authorization: 'Bearer abc', token: 'x', name: 'Ada', nested: { password: 'p', ok: 1 } })
  assert.equal(out.authorization, '[redacted]')
  assert.equal(out.token, '[redacted]')
  assert.equal(out.nested.password, '[redacted]')
  assert.equal(out.name, 'Ada')       // non-sensitive kept
  assert.equal(out.nested.ok, 1)
})

test('redact: masks JWT-ish and Bearer values inside strings', () => {
  const s = redact('auth=Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature end')
  assert.ok(!s.includes('eyJhbGci'))
  assert.ok(s.includes('[redacted]'))
})

test('redact: masks signed-url token/signature query params', () => {
  const s = redact('https://x.supabase.co/o/file?token=SECRETTOKEN&signature=ABC123')
  assert.ok(!s.includes('SECRETTOKEN'))
  assert.ok(!s.includes('ABC123'))
})

test('publicError: generic body, no internal detail, optional requestId', () => {
  const e = publicError()
  assert.equal(e.ok, false)
  assert.equal(typeof e.error, 'string')
  assert.ok(!('stack' in e))
  const e2 = publicError('Nope', 'req-123')
  assert.equal(e2.requestId, 'req-123')
})
