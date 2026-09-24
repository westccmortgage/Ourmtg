// One file, two audiences, and the sheet that gets it into ARIVE.
//
// The contradiction these endpoints exist to prevent is the expensive one: a borrower told
// "you're all set" while a processor's panel shows two outstanding items. It is not fixed by
// being careful on two screens — it is fixed by the two screens being projections of one array,
// and this is the test that says so through the REAL handlers.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'

const LOAN = '33333333-3333-4333-8333-333333333333'
const OWNER = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0'
const BORROWER = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0'
const REALTOR = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const APP = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'

// Seeded as EVENTS, not as projection rows: loadState rebuilds from the log on purpose, so a
// fixture that only fills the projection proves nothing about what the sheet actually reads.
let seq = 0
const event = (path, value, over = {}) => ({
  id: `00000000-0000-4000-8000-0000000ev${String(++seq).padStart(3, '0')}`,
  application_id: APP, loan_file_id: LOAN,
  field_path: path, template_path: path.replace(/\[\d+\]/g, '[]'),
  normalized_value: value, display_value: String(value),
  status: 'confirmed', source: 'borrower_text',
  application_version: 1, catalog_version: 'c1',
  created_at: `2026-08-01T00:00:0${seq}.000Z`, ...over,
})
const projected = (path, value) => ({
  application_id: APP, loan_file_id: LOAN, field_path: path,
  normalized_value: value, status: 'confirmed',
})

function world() {
  const fake = createFakeSupabase({
    users: {
      'tok-owner': { id: OWNER, email: 'lo@wcc.com', aud: 'authenticated' },
      'tok-borrower': { id: BORROWER, email: 'marcus@example.com', aud: 'authenticated' },
      'tok-realtor': { id: REALTOR, email: 'agent@example.com', aud: 'authenticated' },
    },
    tables: {
      loan_files: [{
        id: LOAN, owner_user_id: OWNER, organization_id: 'org-1', borrower_name: 'Marcus Nguyen',
        loan_number: 'WCC-2026-0041', stage: 'application', purpose: 'purchase',
      }],
      portal_access: [
        { portal_user: BORROWER, loan_file_id: LOAN, visibility: 'borrower' },
        { portal_user: REALTOR, loan_file_id: LOAN, visibility: 'realtor' },
      ],
      portal_team: [], portal_access_log: [], loan_messages: [], document_read_jobs: [],
      loan_documents: [{
        id: '00000000-0000-4000-8000-00000000d001', loan_file_id: LOAN, owner_user_id: OWNER,
        doc_key: 'paystubs_30d', label: 'paystubs_30d', status: 'uploaded',
        storage_path: 'loan/33/IMG_7781.pdf', who: 'borrower', uploaded_at: '2026-08-02T10:00:00Z',
      }],
      document_extractions: [],
      // A live finding: the one thing that must reach the team and can never reach the borrower.
      pre_underwriting_findings: [{
        id: '00000000-0000-4000-8000-00000000f001', loan_file_id: LOAN, rule: 'undisclosed_liability',
        category: 'liabilities', severity: 'high', status: 'pending_review',
        explanation: 'Discover shows a payment of $340 not on the application',
        evidence: [], source_documents: ['credit_report'], superseded_by: null,
      }],
      credit_authorizations: [],
      mortgage_applications: [{
        id: APP, loan_file_id: LOAN, organization_id: 'org-1', application_version: 1,
        status: 'in_progress', schema_version: 'v1', catalog_version: 'c1', rules_version: 'r1', locale: 'en',
      }],
      application_parties: [{
        id: 'p1', application_id: APP, loan_file_id: LOAN, party_index: 0, party_role: 'borrower', locale: 'en',
      }],
      application_field_events: [
        event('parties[0].legalFirstName', 'Marcus'),
        event('parties[0].legalLastName', 'Nguyen'),
        event('loan.requestedLoanAmount', 496000),
      ],
      application_field_state: [
        projected('parties[0].legalFirstName', 'Marcus'),
        projected('parties[0].legalLastName', 'Nguyen'),
        projected('loan.requestedLoanAmount', 496000),
      ],
      application_turns: [], application_secure_fields: [], application_attestations: [],
    },
  })
  return fake
}

let bust = 0
async function handlers() {
  setTestEnv({
    PRE_UNDERWRITING_ENABLED: 'true',
    CONVERSATIONAL_1003_ENABLED: 'true',
    OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock', OURMTG_ALLOW_MOCK_SCAN: 'true',
  })
  bust += 1
  const q = `?fs=${bust}`
  return {
    state: (await import(`../netlify/functions/portal-file-state.mjs${q}`)).default,
    handoff: (await import(`../netlify/functions/portal-arive-handoff.mjs${q}`)).default,
  }
}

function install(fake) {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  return () => { globalThis.fetch = original }
}

const GET = (fn, token) => fn(makeRequest(`https://a/x?loanFileId=${LOAN}`, { token }))
const ok = async (res, label) => {
  const body = await res.json()
  assert.equal(res.status, 200, `${label}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

test('the borrower and the team are told the same thing about what is outstanding', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    const mine = await ok(await GET(h.state, 'tok-borrower'), 'borrower')
    const theirs = await ok(await GET(h.state, 'tok-owner'), 'team')

    assert.equal(mine.view, 'borrower')
    assert.equal(theirs.view, 'team')
    // The one number, identical on both screens because it is computed once.
    assert.equal(mine.operational.percent, theirs.operational.percent)
    assert.equal(mine.operational.complete, theirs.operational.complete)

    // Every task the borrower is shown is a task the team can see.
    const teamIds = new Set(theirs.tasks.map((t) => t.id))
    for (const t of mine.tasks) assert.ok(teamIds.has(t.id), `team view is missing ${t.id}`)
    assert.ok(theirs.tasks.length > mine.tasks.length, 'the team sees strictly more')
  } finally { restore() }
})

test('the number never becomes a probability of approval', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    for (const token of ['tok-borrower', 'tok-owner']) {
      const body = await ok(await GET(h.state, token), token)
      assert.match(body.operational.meaning, /present and free of open questions/)
      for (const phrase of ['approval', 'probability', 'credit decision', 'underwriting']) {
        assert.ok(body.operational.notMeaning.some((n) => n.includes(phrase)), `${token}: ${phrase}`)
      }
    }
  } finally { restore() }
})

test('a finding reaches the team and cannot reach the borrower', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    const mine = JSON.stringify(await ok(await GET(h.state, 'tok-borrower'), 'borrower'))
    for (const leak of ['Discover', '340', 'undisclosed']) {
      assert.ok(!mine.includes(leak), `borrower payload leaked "${leak}"`)
    }
    const theirs = await ok(await GET(h.state, 'tok-owner'), 'team')
    assert.ok(theirs.tasks.some((t) => t.kind === 'human_review'), 'the team must see it')
  } finally { restore() }
})

test('a realtor sees nothing here at all', async () => {
  // What is outstanding on a file names the borrower's debts and documents. It is not
  // deal-progress information.
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    assert.equal((await GET(h.state, 'tok-realtor')).status, 403)
    assert.equal((await GET(h.handoff, 'tok-realtor')).status, 403)
    assert.equal((await GET(h.handoff, 'tok-borrower')).status, 403, 'the entry sheet is a processor’s view')
  } finally { restore() }
})

test('the ARIVE sheet never says the file was transferred', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    const body = await ok(await GET(h.handoff, 'tok-owner'), 'handoff')
    assert.equal(body.transfer.occurred, false)
    assert.match(body.transfer.note, /not in ARIVE until someone enters it/)
    const text = JSON.stringify(body)
    for (const claim of [/submitted to arive/i, /transferred to arive/i, /synced with arive/i]) {
      assert.ok(!claim.test(text), `the handoff implied a transfer: ${claim}`)
    }
  } finally { restore() }
})

test('the sheet is typed from what the borrower actually answered', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    const body = await ok(await GET(h.handoff, 'tok-owner'), 'handoff')
    assert.equal(body.ready, true)
    const rows = body.sheet.sections.flatMap((s) => s.rows)
    const first = rows.find((r) => r.path === 'parties[0].legalFirstName')
    assert.equal(first.value, 'Marcus')
    assert.equal(first.missing, false)
    assert.equal(body.sheet.header.loanNumber, 'WCC-2026-0041')
    // And it names what is still blank, before the typist starts.
    assert.ok(body.sheet.outstanding.length > 0)
  } finally { restore() }
})

test('the document package keeps the borrower’s own filenames', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    const body = await ok(await GET(h.handoff, 'tok-owner'), 'handoff')
    const file = body.sheet.documents.sections.flatMap((s) => s.files)[0]
    assert.equal(file.originalName, 'IMG_7781.pdf')
    assert.match(file.filedAs, /^Nguyen_Income_/)
    assert.equal(file.read, false, 'nothing has read it yet, and the sheet says so')
  } finally { restore() }
})

test('a file with no application says so instead of producing a confident empty sheet', async () => {
  const fake = world()
  fake.db.mortgage_applications.length = 0
  const restore = install(fake)
  try {
    const h = await handlers()
    const body = await ok(await GET(h.handoff, 'tok-owner'), 'handoff')
    assert.equal(body.ready, false)
    assert.match(body.reason, /has not started the application/)
    assert.equal(body.transfer.occurred, false)
  } finally { restore() }
})
