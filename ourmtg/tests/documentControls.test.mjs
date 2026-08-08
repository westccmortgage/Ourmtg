import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'

const LOAN = '11111111-1111-4111-8111-111111111111'
const OTHER_LOAN = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BORROWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PATH = `${OWNER}/${LOAN}/bank_2mo-file`

const USERS = {
  'tok-owner': { id: OWNER, email: 'processor@wcc.example', aud: 'authenticated' },
  'tok-borrower': { id: BORROWER, email: 'borrower@example.com', aud: 'authenticated' },
}

function tables() {
  return {
    loan_files: [
      { id: LOAN, owner_user_id: OWNER, borrower_name: 'Correct Borrower', stage: 'lead' },
      { id: OTHER_LOAN, owner_user_id: OWNER, borrower_name: 'Other Borrower', stage: 'lead' },
    ],
    portal_access: [{ portal_user: BORROWER, loan_file_id: LOAN, visibility: 'borrower' }],
    portal_team: [],
    loan_documents: [{
      id: DOC, loan_file_id: LOAN, owner_user_id: OWNER, doc_key: 'bank_2mo',
      label: 'Bank statements', who: 'borrower', status: 'uploaded', storage_path: PATH,
      uploaded_at: '2026-08-08T10:00:00.000Z', reject_reason: null,
    }],
    document_extractions: [{ id: 'read-1', document_id: DOC, loan_file_id: LOAN, fields: { fields: [] } }],
    portal_access_log: [],
    loan_conditions: [],
    loan_messages: [],
    portal_users: [],
  }
}

let bust = 0
async function handlers() {
  setTestEnv()
  bust++
  return {
    remove: (await import(`../netlify/functions/portal-doc-remove.mjs?t=${bust}`)).default,
    detail: (await import(`../netlify/functions/portal-file-detail.mjs?t=${bust}`)).default,
  }
}

function install(fake) {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  return () => { globalThis.fetch = original }
}

test('loan team removal destroys document bytes and extracted values, then hides the tombstone', async () => {
  const fake = createFakeSupabase({
    tables: tables(),
    users: USERS,
    storage: { [PATH]: { body: Buffer.from('%PDF-1.7\nprivate'), type: 'application/pdf' } },
  })
  const restore = install(fake)
  try {
    const h = await handlers()
    const response = await h.remove(makeRequest('https://app.test/.netlify/functions/portal-doc-remove', {
      method: 'POST', token: 'tok-owner',
      body: { loanFileId: LOAN, documentId: DOC, reason: 'Uploaded to the wrong borrower file' },
    }))
    assert.equal(response.status, 200)
    assert.equal(fake.files[PATH], undefined)
    assert.equal(fake.rowsOf('document_extractions').length, 0)

    const row = fake.rowsOf('loan_documents')[0]
    assert.equal(row.storage_path, null)
    assert.equal(row.status, 'rejected')
    assert.match(row.reject_reason, /^__REMOVED__:/)
    const audit = fake.rowsOf('portal_access_log').find((entry) => entry.action === 'remove_doc')
    assert.equal(audit.portal_user, OWNER)
    assert.equal(audit.target, `document:${DOC}`)

    const detail = await h.detail(makeRequest(`https://app.test/.netlify/functions/portal-file-detail?loanFileId=${LOAN}`, {
      token: 'tok-owner',
    }))
    assert.equal(detail.status, 200)
    assert.deepEqual((await detail.json()).documents, [])
  } finally { restore() }
})

test('borrowers cannot remove documents and a document cannot be removed through another file id', async () => {
  const fake = createFakeSupabase({ tables: tables(), users: USERS, storage: {
    [PATH]: { body: Buffer.from('%PDF-1.7\nprivate'), type: 'application/pdf' },
  } })
  const restore = install(fake)
  try {
    const h = await handlers()
    const borrower = await h.remove(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, documentId: DOC, reason: 'Please remove this' },
    }))
    assert.equal(borrower.status, 403)

    const wrongFile = await h.remove(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: { loanFileId: OTHER_LOAN, documentId: DOC, reason: 'Wrong file' },
    }))
    assert.equal(wrongFile.status, 404)
    assert.ok(fake.files[PATH])
    assert.equal(fake.rowsOf('document_extractions').length, 1)
  } finally { restore() }
})

