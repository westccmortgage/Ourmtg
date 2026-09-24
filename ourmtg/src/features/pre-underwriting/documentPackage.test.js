// A filename is the least controlled surface in this product: it travels into email subjects,
// shared folders, and screenshots. These tests hold two lines — nothing is renamed in storage,
// and nothing sensitive is derived into a name.

import test from 'node:test'
import assert from 'node:assert/strict'
import { organizeDocuments } from './documentPackage.js'

const doc = (over = {}) => ({
  id: over.id || 'd1', doc_key: 'bank_2mo', label: 'bank_2mo', status: 'uploaded',
  storage_path: 'loan/abc/IMG_4821.pdf', uploaded_at: '2026-08-02T10:00:00Z', ...over,
})
const read = (documentId, docKey, fields, over = {}) => ({
  documentId, docKey, fields: Object.entries(fields).map(([name, value]) => ({ name, value, confidence: 0.95 })),
  createdAt: '2026-08-02T10:05:00Z', ...over,
})

test('the original name is preserved exactly and the derived name is separate', () => {
  const out = organizeDocuments({
    documents: [doc({ storage_path: 'loan/abc/Scan 2026-08-02 (1).pdf' })],
    extractions: [read('d1', 'bank_2mo', { statementMonth: '2026-07', institutionName: 'Chase Bank' })],
    borrowerName: 'Marcus Nguyen',
  })
  const f = out.sections[0].files[0]
  assert.equal(f.originalName, 'Scan 2026-08-02 (1).pdf', 'the borrower’s own name must survive byte for byte')
  assert.equal(f.filedAs, 'Nguyen_Assets_BankStatements2MostRecentMonths_ChaseBank_2026-07_1.pdf')
  assert.notEqual(f.originalName, f.filedAs)
})

test('the mapping says why each name is what it is', () => {
  // Reversible a year later, by a person who was not here: that is what makes the rename safe.
  const out = organizeDocuments({
    documents: [doc()],
    extractions: [read('d1', 'bank_2mo', { statementMonth: '2026-07', institutionName: 'Chase Bank' })],
    borrowerName: 'Marcus Nguyen',
  })
  const m = out.mapping[0]
  assert.equal(m.originalName, 'IMG_4821.pdf')
  assert.match(m.basis.join(' | '), /type read from the document/)
  assert.match(m.basis.join(' | '), /period read from the document \(2026-07\)/)
  assert.match(m.basis.join(' | '), /institution read from the document \(Chase Bank\)/)
})

test('nothing off the document leaks into a filename', () => {
  const out = organizeDocuments({
    documents: [doc({ doc_key: 'credit_report', storage_path: 'loan/abc/cr.pdf' })],
    extractions: [read('d1', 'credit_report', {
      borrowerName: 'Marcus Nguyen', equifaxScore: 612, experianScore: 640,
      accountNumber: '4111111111111111', ssn: '123-45-6789', reportDate: '2026-08-01',
    })],
    borrowerName: 'Marcus Nguyen',
  })
  const f = out.sections[0].files[0]
  for (const secret of ['612', '640', '4111', '123', '6789']) {
    assert.ok(!f.filedAs.includes(secret), `filename leaked "${secret}": ${f.filedAs}`)
  }
})

test('two documents of the same kind and period get different names', () => {
  const out = organizeDocuments({
    documents: [doc({ id: 'd1' }), doc({ id: 'd2', storage_path: 'loan/abc/IMG_4822.pdf' })],
    extractions: [
      read('d1', 'bank_2mo', { statementMonth: '2026-07' }),
      read('d2', 'bank_2mo', { statementMonth: '2026-07' }),
    ],
    borrowerName: 'Marcus Nguyen',
  })
  const names = out.sections[0].files.map((f) => f.filedAs)
  assert.equal(new Set(names).size, 2, names.join(' vs '))
})

test('what the page says it is beats the slot it was uploaded to', () => {
  // A borrower who drops a W-2 into the pay-stub request has still uploaded a W-2, and filing it
  // as a pay stub is how it gets lost.
  const out = organizeDocuments({
    documents: [doc({ doc_key: 'paystubs_30d', storage_path: 'loan/abc/x.pdf' })],
    extractions: [read('d1', 'w2_2yr', { taxYear: 2025 }, { docKeyMismatch: true })],
    borrowerName: 'Marcus Nguyen',
  })
  const f = out.sections[0].files[0]
  assert.equal(f.docKey, 'w2_2yr')
  assert.match(f.filedAs, /2025/)
  assert.equal(f.misfiled, true, 'the disagreement is surfaced, not smoothed over')
})

test('an unread document is still filed, and says so', () => {
  const out = organizeDocuments({
    documents: [doc({ storage_path: 'loan/abc/mystery.pdf' })],
    extractions: [],
    borrowerName: 'Marcus Nguyen',
  })
  const f = out.sections[0].files[0]
  assert.equal(f.read, false)
  assert.equal(out.unread, 1)
  assert.match(f.basis.join(' '), /not read yet/)
  // No invented period: nothing told us what it covers.
  assert.ok(!/\d{4}-\d{2}/.test(f.filedAs), f.filedAs)
})

test('a name is safe to put in a folder, an email, or a shell', () => {
  const out = organizeDocuments({
    documents: [doc({ storage_path: 'loan/abc/../../etc/passwd.pdf' })],
    extractions: [read('d1', 'bank_2mo', { institutionName: 'Banco Español; rm -rf /' })],
    borrowerName: "O'Brien-Nguyen  ",
  })
  const f = out.sections[0].files[0]
  assert.match(f.filedAs, /^[A-Za-z0-9_.-]+$/, f.filedAs)
  assert.ok(!f.filedAs.includes('..'), f.filedAs)
})

test('documents land in the sections a processor works in', () => {
  const out = organizeDocuments({
    documents: [
      doc({ id: 'd1', doc_key: 'id_photo', storage_path: 'a/id.png' }),
      doc({ id: 'd2', doc_key: 'paystubs_30d', storage_path: 'a/stub.pdf' }),
      doc({ id: 'd3', doc_key: 'bank_2mo', storage_path: 'a/bank.pdf' }),
      doc({ id: 'd4', doc_key: 'purchase_contract', storage_path: 'a/psa.pdf' }),
    ],
    extractions: [],
    borrowerName: 'Marcus Nguyen',
  })
  assert.deepEqual(out.sections.map((s) => s.key), ['identity', 'income', 'assets', 'property'])
  assert.equal(out.total, 4)
})

test('a tax return spanning two years says so', () => {
  const out = organizeDocuments({
    documents: [doc({ doc_key: 'tax_return_full', storage_path: 'a/1040.pdf' })],
    extractions: [{
      documentId: 'd1', docKey: 'tax_return_full', fields: [],
      taxForms: [{ formType: '1040', taxYear: 2024 }, { formType: '1040', taxYear: 2025 }],
      createdAt: '2026-08-02T10:05:00Z',
    }],
    borrowerName: 'Marcus Nguyen',
  })
  assert.match(out.sections[0].files[0].filedAs, /2024-2025/)
})
