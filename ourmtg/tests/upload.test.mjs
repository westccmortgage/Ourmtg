// Document upload-policy tests (Phase 1A §7).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isAllowedDocMime, hasDangerousExtension, normalizeFilename, validateUpload, ALLOWED_DOC_MIME,
  sniffDocumentMime, inspectDocumentBytes,
} from '../netlify/functions/_lib/upload-policy.mjs'
import {
  createScanProvider, scanDecision, preUnderwritingScanRequired,
} from '../netlify/functions/_lib/scan-provider.mjs'

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

test('sniffDocumentMime recognizes only the allowed byte signatures', () => {
  assert.equal(sniffDocumentMime(Buffer.from('%PDF-1.7\n')), 'application/pdf')
  assert.equal(sniffDocumentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffDocumentMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffDocumentMime(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])), 'image/heic')
  assert.equal(sniffDocumentMime(Buffer.from('<html><script>alert(1)</script>')), null)
  assert.equal(sniffDocumentMime(Buffer.from('MZ executable renamed statement.pdf')), null)
})

test('inspectDocumentBytes rejects renamed or unknown content and trusts detected bytes', () => {
  const pdf = Buffer.from('%PDF-1.7\n')
  assert.deepEqual(inspectDocumentBytes(pdf, { declaredContentType: 'application/pdf' }), {
    ok: true, detectedContentType: 'application/pdf',
  })
  assert.equal(inspectDocumentBytes(pdf, { declaredContentType: 'image/png' }).code, 'content_type_mismatch')
  assert.equal(inspectDocumentBytes(Buffer.from('<svg></svg>'), { declaredContentType: 'application/pdf' }).code, 'unsupported_file_content')
  assert.equal(inspectDocumentBytes(Buffer.alloc(0)).code, 'empty_file')
})

test('document scanning is fail-closed for pre-underwriting and mocks require explicit permission', async () => {
  assert.equal(preUnderwritingScanRequired({}), true)
  assert.equal(preUnderwritingScanRequired({ PRE_UNDERWRITING_REQUIRE_CLEAN_SCAN: 'false' }), false)
  assert.throws(() => createScanProvider({ env: { OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock' } }), /not allowed/)
  const scanner = createScanProvider({ env: {
    OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock', OURMTG_ALLOW_MOCK_SCAN: 'true', OURMTG_MOCK_SCAN_STATUS: 'clean',
  } })
  assert.deepEqual(await scanner.scan({ bucket: 'b', path: 'p' }), { status: 'clean' })
  assert.equal(scanDecision({ status: 'unscanned' }, { required: true }).code, 'scan_not_configured')
  assert.equal(scanDecision({ status: 'infected' }, { required: false }).code, 'malware_detected')
  assert.equal(scanDecision({ status: 'clean' }, { required: true }).ok, true)
})
