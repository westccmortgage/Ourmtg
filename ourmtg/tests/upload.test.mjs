// Document upload-policy tests (Phase 1A §7).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isAllowedDocMime, hasDangerousExtension, normalizeFilename, validateUpload, ALLOWED_DOC_MIME,
} from '../netlify/functions/_lib/upload-policy.mjs'

test('isAllowedDocMime: PDF/JPEG/PNG/HEIC allowed; HTML/SVG/exe rejected', () => {
  for (const m of ALLOWED_DOC_MIME) assert.equal(isAllowedDocMime(m), true, m)
  assert.equal(isAllowedDocMime('image/JPEG'), true) // case-insensitive
  for (const m of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'application/octet-stream', '', null]) {
    assert.equal(isAllowedDocMime(m), false, String(m))
  }
})

test('hasDangerousExtension: catches active content and double extensions', () => {
  assert.equal(hasDangerousExtension('statement.pdf'), false)
  assert.equal(hasDangerousExtension('photo.jpg'), false)
  assert.equal(hasDangerousExtension('id.svg'), true)
  assert.equal(hasDangerousExtension('report.pdf.exe'), true)   // double extension
  assert.equal(hasDangerousExtension('invoice.html'), true)
  assert.equal(hasDangerousExtension('run.sh'), true)
  assert.equal(hasDangerousExtension('a.PDF.EXE'), true)        // case-insensitive
})

test('normalizeFilename: strips path separators and unsafe chars, caps length', () => {
  assert.equal(normalizeFilename('../../etc/passwd'), '.. .. etc passwd'.replace(/\s+/g, ' ').trim())
  assert.equal(normalizeFilename('my bank\\statement.pdf'), 'my bank statement.pdf')
  assert.equal(normalizeFilename(''), 'document')
  assert.ok(normalizeFilename('x'.repeat(500)).length <= 128)
})

test('validateUpload: allows a clean PDF, rejects bad MIME and dangerous names', () => {
  assert.equal(validateUpload({ contentType: 'application/pdf', filename: 'w2.pdf' }).ok, true)
  assert.equal(validateUpload({ contentType: 'application/pdf', filename: 'w2.pdf.exe' }).ok, false) // double ext
  assert.equal(validateUpload({ contentType: 'text/html', filename: 'x.html' }).ok, false)
  assert.equal(validateUpload({ contentType: 'image/svg+xml' }).ok, false)
  assert.equal(validateUpload({ contentType: undefined }).ok, false) // unknown declared type rejected
})
