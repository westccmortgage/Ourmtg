import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'
import { applicationProgress, summarizeOwners } from '../netlify/functions/_lib/portfolio.mjs'

const ADMIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ADMIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OUTSIDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const STRANGER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const FILE_A = '11111111-1111-4111-8111-111111111111'
const FILE_B = '22222222-2222-4222-8222-222222222222'
const FILE_OUT = '33333333-3333-4333-8333-333333333333'

const USERS = {
  'token-admin-a': { id: ADMIN_A, email: 'admin-a@example.com', last_sign_in_at: '2026-08-08T01:00:00Z', app_metadata: { provider: 'google' } },
  'token-admin-b': { id: ADMIN_B, email: 'admin-b@example.com', last_sign_in_at: '2026-08-07T01:00:00Z', app_metadata: { provider: 'google' } },
  'token-team': { id: TEAM, email: 'processor@example.com', app_metadata: { provider: 'google' } },
  'token-outsider': { id: OUTSIDER, email: 'outside@example.com', app_metadata: { provider: 'google' } },
  'token-stranger': { id: STRANGER, email: 'stranger@example.com', app_metadata: { provider: 'google' } },
}

function tables() {
  return {
    portal_team: [{ owner_user_id: ADMIN_A, member_user_id: TEAM, role: 'processor' }],
    loan_files: [
      { id: FILE_A, owner_user_id: ADMIN_A, borrower_name: 'Alpha Borrower', stage: 'lead', created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z' },
      { id: FILE_B, owner_user_id: ADMIN_B, borrower_name: 'Beta Borrower', stage: 'underwriting', created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z' },
      { id: FILE_OUT, owner_user_id: OUTSIDER, borrower_name: 'Must Stay Hidden', stage: 'funded', created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z' },
    ],
    mortgage_applications: [
      { loan_file_id: FILE_A, application_version: 1, status: 'in_progress', percent_complete: 42, updated_at: '2026-08-08T01:00:00Z' },
      { loan_file_id: FILE_B, application_version: 1, status: 'borrower_attested', percent_complete: 100, updated_at: '2026-08-08T02:00:00Z' },
    ],
    loan_documents: [],
    loan_messages: [],
    loan_conditions: [],
  }
}

let bust = 0
async function handler(adminEmails = 'admin-a@example.com,admin-b@example.com,not-signed-in@example.com') {
  setTestEnv({ OURMTG_ADMIN_EMAILS: adminEmails })
  bust++
  return (await import(`../netlify/functions/portal-review-queue.mjs?portfolio=${bust}`)).default
}

function install(fake) {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  return () => { globalThis.fetch = original }
}

test('application portfolio uses stored status and preserves null instead of inventing 0%', () => {
  assert.deepEqual(applicationProgress(null), {
    status: 'not_started', bucket: 'notStarted', label: 'Not started', percentComplete: null, updatedAt: null,
  })
  assert.equal(applicationProgress({ status: 'in_progress', percent_complete: '' }).percentComplete, null)
  assert.equal(applicationProgress({ status: 'borrower_attested', percent_complete: 100 }).bucket, 'attested')

  const owners = summarizeOwners(
    [{ userId: ADMIN_A, email: 'admin-a@example.com' }],
    [{ ownerUserId: ADMIN_A, stage: 'lead', application: applicationProgress({ status: 'in_progress', percent_complete: 42 }) }],
  )
  assert.equal(owners[0].fileCount, 1)
  assert.equal(owners[0].applicationCounts.inProgress, 1)
  assert.equal(owners[0].stageCounts.lead, 1)
})

test('platform admin receives configured admin portfolios, real owner identities, and no outsider files', async () => {
  const fake = createFakeSupabase({ tables: tables(), users: USERS })
  const restore = install(fake)
  try {
    const run = await handler()
    const response = await run(makeRequest('https://app.test/.netlify/functions/portal-review-queue', { token: 'token-admin-a' }))
    assert.equal(response.status, 200)
    const body = await response.json()

    assert.equal(body.workspace.identity.email, 'admin-a@example.com')
    assert.equal(body.workspace.identity.provider, 'google')
    assert.equal(body.workspace.platformAdmin, true)
    assert.deepEqual(body.files.map((file) => file.borrowerName), ['Alpha Borrower'])
    assert.equal(body.files.some((file) => file.borrowerName === 'Must Stay Hidden'), false)
    assert.deepEqual(body.workspace.accessibleOwnerIds, [ADMIN_A])

    const adminA = body.workspace.owners.find((owner) => owner.email === 'admin-a@example.com')
    const adminB = body.workspace.owners.find((owner) => owner.email === 'admin-b@example.com')
    const notSignedIn = body.workspace.owners.find((owner) => owner.email === 'not-signed-in@example.com')
    assert.equal(adminA.fileCount, 1)
    assert.equal(adminA.applicationCounts.inProgress, 1)
    assert.equal(adminB.fileCount, 1)
    assert.equal(adminB.applicationCounts.attested, 1)
    assert.equal(notSignedIn.userId, null)
    assert.equal(notSignedIn.fileCount, 0)
  } finally { restore() }
})

test('team member remains limited to the owner relationship granted by portal_team', async () => {
  const fake = createFakeSupabase({ tables: tables(), users: USERS })
  const restore = install(fake)
  try {
    const run = await handler()
    const response = await run(makeRequest('https://app.test/.netlify/functions/portal-review-queue', { token: 'token-team' }))
    const body = await response.json()
    assert.equal(body.internal, true)
    assert.equal(body.workspace.platformAdmin, false)
    assert.deepEqual(body.files.map((file) => file.borrowerName), ['Alpha Borrower'])
    assert.equal(body.workspace.owners.length, 1)
    assert.equal(body.workspace.owners[0].email, 'admin-a@example.com')
    assert.equal(body.workspace.owners[0].relation, 'processor')
  } finally { restore() }
})

test('unrelated authenticated account receives no owner portfolio or file data', async () => {
  const fake = createFakeSupabase({ tables: tables(), users: USERS })
  const restore = install(fake)
  try {
    const run = await handler()
    const response = await run(makeRequest('https://app.test/.netlify/functions/portal-review-queue', { token: 'token-stranger' }))
    const body = await response.json()
    assert.equal(body.internal, false)
    assert.deepEqual(body.files, [])
    assert.deepEqual(body.workspace.owners, [])
  } finally { restore() }
})
