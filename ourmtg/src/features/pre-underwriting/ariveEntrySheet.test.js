// The sheet a person reads while typing this file into ARIVE.
//
// The two things that would make it dangerous: claiming a transfer that did not happen, and
// letting a blank box look like a filled one.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAriveEntrySheet, TRANSFER_DISCLAIMER } from './ariveEntrySheet.js'

const leaf = (over = {}) => ({
  value: null, display: null, status: 'confirmed', source: 'borrower_text',
  estimated: false, confirmed: true, redacted: false, urla: null, ulad: null, mismo: null, ...over,
})

const canonical = (over = {}) => ({
  format: 'ourmtg.conversational1003.v1',
  schemaVersion: 'v1', catalogVersion: 'c1', generatedAt: '2026-09-01T00:00:00Z',
  applicationId: 'app-1', loanFileId: 'lf-1',
  parties: [{
    legalFirstName: leaf({ value: 'Marcus', display: 'Marcus' }),
    legalLastName: leaf({ value: 'Nguyen', display: 'Nguyen' }),
    ssn: leaf({ value: null, display: '••••', redacted: true }),
    employment: [
      { employerName: leaf({ value: 'Acme Co', display: 'Acme Co' }) },
      { employerName: leaf({ value: 'Beta LLC', display: 'Beta LLC' }) },
    ],
  }],
  loan: {
    requestedLoanAmount: leaf({ value: 496000, display: '$496,000', estimated: true, confirmed: false }),
  },
  unresolved: [], structuralGaps: [], contradictions: [],
  completeness: { percent: 70 },
  ...over,
})

test('the sheet never claims anything was sent', () => {
  const sheet = buildAriveEntrySheet(canonical())
  const text = JSON.stringify(sheet)
  for (const claim of [/submitted to arive/i, /transferred/i, /synced/i, /pushed to/i, /uploaded to arive/i]) {
    assert.ok(!claim.test(text), `the sheet implied a transfer: ${claim}`)
  }
  assert.match(sheet.disclaimer[0], /Nothing has been sent to ARIVE/)
  assert.equal(sheet.disclaimer, TRANSFER_DISCLAIMER)
})

test('the sheet cannot be rendered without saying what it is not', () => {
  const sheet = buildAriveEntrySheet(canonical())
  for (const phrase of ['approval', 'credit decision', 'underwriting opinion', 'commitment to lend']) {
    assert.ok(sheet.notMeaning.some((n) => n.includes(phrase)), phrase)
  }
})

test('an unanswered required field is a row, not an absence', () => {
  // The bug this prevents: a blank box that is invisible on the sheet gets skipped in ARIVE and
  // nobody discovers it until underwriting.
  const sheet = buildAriveEntrySheet(canonical({
    unresolved: [{ path: 'parties[0].dateOfBirth', section: 'identity', status: 'unanswered' }],
  }))
  const row = sheet.sections.flatMap((s) => s.rows).find((r) => r.path === 'parties[0].dateOfBirth')
  assert.ok(row, 'the missing field is on the sheet')
  assert.equal(row.missing, true)
  assert.equal(row.value, '')
  assert.equal(sheet.counts.missing, 1)
  assert.ok(sheet.outstanding.some((o) => o.path === 'parties[0].dateOfBirth'))
})

test('a secure value is never on the sheet, and says where to get it', () => {
  const sheet = buildAriveEntrySheet(canonical())
  const ssn = sheet.sections.flatMap((s) => s.rows).find((r) => r.path === 'parties[0].ssn')
  assert.ok(ssn)
  assert.equal(ssn.value, '')
  assert.equal(ssn.redacted, true)
  assert.match(ssn.note, /Collect it directly in ARIVE/)
  // And it is not counted as something a typist can fill in from this page.
  assert.equal(sheet.counts.redacted, 1)
  assert.ok(!JSON.stringify(sheet).includes('••••'))
})

test('a soft number is marked soft', () => {
  const sheet = buildAriveEntrySheet(canonical())
  const amount = sheet.sections.flatMap((s) => s.rows).find((r) => r.path === 'loan.requestedLoanAmount')
  assert.equal(amount.value, '$496,000')
  assert.equal(amount.estimated, true)
  assert.match(amount.note, /not verified against a document/)
  assert.equal(sheet.counts.unconfirmed, 1)
})

test('repeated entries are numbered the way the form asks for them', () => {
  const sheet = buildAriveEntrySheet(canonical())
  const labels = sheet.sections.flatMap((s) => s.rows).map((r) => r.label)
  assert.ok(labels.some((l) => /^Employer 1 — /.test(l)), labels.join(' | '))
  assert.ok(labels.some((l) => /^Employer 2 — /.test(l)), labels.join(' | '))
})

test('the sheet refuses to resolve a contradiction', () => {
  // Picking one would put a wrong number into the system of record with a confident provenance.
  const sheet = buildAriveEntrySheet(canonical({
    contradictions: [{ path: 'loan.requestedLoanAmount', section: 'loan' }],
  }))
  assert.equal(sheet.contradictions.length, 1)
  assert.match(sheet.contradictions[0].note, /Confirm with the borrower before entering/)
  assert.ok(!('chosen' in sheet.contradictions[0]))
})

test('the sheet computes no mortgage numbers of its own', () => {
  const sheet = buildAriveEntrySheet(canonical())
  const text = JSON.stringify(sheet).toLowerCase()
  for (const conclusion of ['"dti"', '"ltv"', 'qualifyingincome', 'creditscore', 'programfit']) {
    assert.ok(!text.includes(conclusion), `the sheet carried a conclusion: ${conclusion}`)
  }
})

test('no field appears twice', () => {
  const rows = buildAriveEntrySheet(canonical({
    // The same path both answered and listed as unresolved — which is what a race between a
    // late answer and a cached report looks like.
    unresolved: [{ path: 'parties[0].legalFirstName', section: 'identity', status: 'unanswered' }],
  })).sections.flatMap((s) => s.rows)
  const paths = rows.map((r) => r.path)
  assert.equal(new Set(paths).size, paths.length, 'a duplicated row means the typist enters it twice')
  // The ANSWER wins over the stale "unresolved" entry, not the other way round.
  assert.equal(rows.find((r) => r.path === 'parties[0].legalFirstName').value, 'Marcus')
})

test('the document package rides along so the typist knows what backs each number', () => {
  const sheet = buildAriveEntrySheet(canonical(), {
    documents: {
      total: 2, unread: 1,
      sections: [{ key: 'income', title: 'Income', files: [
        { label: 'Pay stubs', filedAs: 'Nguyen_Income_PayStubs_2026-08_1.pdf', originalName: 'IMG_1.pdf', read: true },
      ] }],
    },
  })
  assert.equal(sheet.documents.total, 2)
  assert.equal(sheet.documents.unread, 1)
  assert.equal(sheet.documents.sections[0].files[0].originalName, 'IMG_1.pdf')
})

test('an empty file produces an empty sheet rather than throwing', () => {
  const sheet = buildAriveEntrySheet({ parties: [], loan: {}, unresolved: [], contradictions: [] })
  assert.deepEqual(sheet.sections, [])
  assert.equal(sheet.counts.total, 0)
  assert.equal(sheet.disclaimer.length, TRANSFER_DISCLAIMER.length)
})
