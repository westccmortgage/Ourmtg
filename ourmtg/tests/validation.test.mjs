// Public-input validation/normalization tests (Phase 1A Blocker C).
import test from 'node:test'
import assert from 'node:assert/strict'

import { isJsonContentType, normalizeEmail, isValidEmail, normalizePhone, isValidPhone } from '../netlify/functions/_lib/validation.mjs'

function mkReq(ct) {
  return { headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? ct : null) } }
}

test('isJsonContentType: accepts JSON, rejects others', () => {
  assert.equal(isJsonContentType(mkReq('application/json')), true)
  assert.equal(isJsonContentType(mkReq('application/json; charset=utf-8')), true)
  assert.equal(isJsonContentType(mkReq('text/plain')), false)
  assert.equal(isJsonContentType(mkReq('multipart/form-data; boundary=x')), false)
  assert.equal(isJsonContentType(mkReq('')), false)
})

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com')
})

test('isValidEmail: accepts normal, rejects malformed and injection', () => {
  assert.equal(isValidEmail('ada@example.com'), true)
  assert.equal(isValidEmail('a.b+tag@sub.domain.io'), true)
  assert.equal(isValidEmail('nope'), false)
  assert.equal(isValidEmail('a@b'), false)          // no TLD dot
  assert.equal(isValidEmail('a@@b.com'), false)
  assert.equal(isValidEmail('a b@x.com'), false)     // whitespace
  assert.equal(isValidEmail('a@x.com<script>'), false)
  assert.equal(isValidEmail(''), false)
})

test('normalizePhone strips formatting, keeps leading +', () => {
  assert.equal(normalizePhone('(310) 654-1577'), '3106541577')
  assert.equal(normalizePhone('+1 310-654-1577'), '+13106541577')
  assert.equal(normalizePhone(''), '')
})

test('isValidPhone: 10-15 digits', () => {
  assert.equal(isValidPhone('(310) 654-1577'), true)
  assert.equal(isValidPhone('+13106541577'), true)
  assert.equal(isValidPhone('123'), false)          // too short
  assert.equal(isValidPhone('abc'), false)
  assert.equal(isValidPhone('1234567890123456'), false) // too long
})
