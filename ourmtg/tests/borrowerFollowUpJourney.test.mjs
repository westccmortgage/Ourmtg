// The loop this product exists to close, driven through the REAL handlers.
//
// The expensive workflow today:
//   borrower uploads → loan officer eventually looks → officer discovers page 6 is missing →
//   officer calls or texts → borrower uploads page 6 → officer looks again.
//
// Every arrow but the first and the last is a person's afternoon, and the borrower spends the
// gap between them not knowing whether they are finished. This test is the same story with
// nobody in it:
//
//   Marcus uploads a July bank statement. Pages 1–5 and 7 came through; page 6 did not.
//   Nobody presses anything. A minute later he has a message naming page 6.
//   He sends page 6. A minute later he has a message saying the statement is complete.
//
// Asserted the way a borrower would notice it: by reading the message.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'

const LOAN = '22222222-2222-4222-8222-222222222222'
const OWNER = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0'
const BORROWER = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0'
const DOC = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d001'
const PAGE6 = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d002'

const ym = (offset) => {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() + offset)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const THIS_MONTH = ym(0)
const LAST_MONTH = ym(-1)
const endOf = (m) => `${m}-28`

// Two readings of the same account. PARTIAL is what a phone camera produces when someone
// photographs a stapled statement and a page sticks; WHOLE is the same statement after the
// borrower goes back for the one page they skipped.
const READINGS = {
  PARTIAL: {
    docKey: 'bank_2mo', docKeyConfidence: 0.97,
    fields: [
      { name: 'accountHolder', value: 'Marcus T', confidence: 0.95 },
      { name: 'institutionName', value: 'Chase Bank', confidence: 0.96 },
      { name: 'statementMonth', value: THIS_MONTH, confidence: 0.97 },
      { name: 'statementEnd', value: endOf(THIS_MONTH), confidence: 0.97 },
      { name: 'pagesSeen', value: '1-5, 7', confidence: 0.94 },
      { name: 'pagesTotal', value: 7, confidence: 0.95 },
    ],
  },
  WHOLE: {
    docKey: 'bank_2mo', docKeyConfidence: 0.97,
    fields: [
      { name: 'accountHolder', value: 'Marcus T', confidence: 0.95 },
      { name: 'institutionName', value: 'Chase Bank', confidence: 0.96 },
      { name: 'statementMonth', value: THIS_MONTH, confidence: 0.97 },
      { name: 'statementEnd', value: endOf(THIS_MONTH), confidence: 0.97 },
      { name: 'pagesSeen', value: '1,2,3,4,5,6,7', confidence: 0.96 },
      { name: 'pagesTotal', value: 7, confidence: 0.95 },
    ],
  },
  PRIOR: {
    docKey: 'bank_2mo', docKeyConfidence: 0.97,
    fields: [
      { name: 'accountHolder', value: 'Marcus T', confidence: 0.95 },
      { name: 'institutionName', value: 'Chase Bank', confidence: 0.96 },
      { name: 'statementMonth', value: LAST_MONTH, confidence: 0.97 },
      { name: 'statementEnd', value: endOf(LAST_MONTH), confidence: 0.97 },
      { name: 'pagesSeen', value: '1-7', confidence: 0.96 },
      { name: 'pagesTotal', value: 7, confidence: 0.95 },
    ],
  },
}

// The model stub routes on the document's own bytes, so this also proves the file the endpoint
// uploaded is the file that reached the reader.
const model = () => async (url, init) => {
  const body = JSON.parse(init.body)
  const raw = Buffer.from(body.messages[0].content[0].source.data, 'base64').toString('utf8')
  const tag = Object.keys(READINGS).find((t) => raw.includes(t))
  if (!tag) throw new Error('model stub got an unexpected document')
  return {
    ok: true, status: 200,
    json: async () => ({
      stop_reason: 'end_turn', model: 'claude-opus-5',
      usage: { input_tokens: 900, output_tokens: 150 },
      content: [{ type: 'text', text: JSON.stringify(READINGS[tag]) }],
    }),
  }
}

function world() {
  const fake = createFakeSupabase({
    users: {
      'tok-owner': { id: OWNER, email: 'lo@wcc.com', aud: 'authenticated' },
      'tok-borrower': { id: BORROWER, email: 'marcus@example.com', aud: 'authenticated' },
    },
    tables: {
      loan_files: [{
        id: LOAN, owner_user_id: OWNER, organization_id: 'org-1',
        borrower_name: 'Marcus T', stage: 'application', purpose: 'purchase',
      }],
      portal_access: [{ portal_user: BORROWER, loan_file_id: LOAN, visibility: 'borrower' }],
      portal_team: [], portal_access_log: [], loan_messages: [],
      loan_documents: [
        // The prior month, already read: without it every follow-up would also be chasing June,
        // and the test would not be about page 6 at all.
        {
          id: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d000', loan_file_id: LOAN, owner_user_id: OWNER,
          doc_key: 'bank_2mo', label: 'bank_2mo', status: 'uploaded', storage_path: 'f/prior.pdf', who: 'borrower',
        },
        {
          id: DOC, loan_file_id: LOAN, owner_user_id: OWNER, doc_key: 'bank_2mo',
          label: 'bank_2mo', status: 'requested', storage_path: 'f/partial.pdf', who: 'borrower',
        },
      ],
      document_extractions: [], pre_underwriting_findings: [], credit_authorizations: [],
      document_read_jobs: [],
      mortgage_applications: [], application_parties: [], application_field_events: [],
      application_field_state: [], application_turns: [],
    },
  })
  fake.putFile('f/prior.pdf', Buffer.from('%PDF-1.4\nPRIOR'), 'application/pdf')
  fake.putFile('f/partial.pdf', Buffer.from('%PDF-1.4\nPARTIAL'), 'application/pdf')
  fake.putFile('f/whole.pdf', Buffer.from('%PDF-1.4\nWHOLE'), 'application/pdf')
  return fake
}

let bust = 0
async function handlers() {
  setTestEnv({
    PRE_UNDERWRITING_ENABLED: 'true',
    CONVERSATIONAL_1003_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'test-key-not-real',
    OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock',
    OURMTG_ALLOW_MOCK_SCAN: 'true',
    OURMTG_READ_WORKER_KEY: 'worker-key-for-tests',
  })
  bust += 1
  const q = `?followup=${bust}`
  return {
    complete: (await import(`../netlify/functions/portal-doc-complete.mjs${q}`)).default,
    worker: (await import(`../netlify/functions/pre-underwriting-read-worker.mjs${q}`)).default,
  }
}

function install(fake) {
  const original = globalThis.fetch
  const m = model()
  globalThis.fetch = async (url, opts) => (
    String(url).includes('api.anthropic.com') ? m(url, opts) : fake.fetch(url, opts)
  )
  return () => { globalThis.fetch = original }
}

const uploadDone = (documentId) => makeRequest('https://a/x', {
  method: 'POST', token: 'tok-borrower', body: { documentId },
})
const tick = () => makeRequest('https://a/pre-underwriting-read-worker', {
  method: 'POST', body: { next_run: new Date(Date.now() + 60_000).toISOString() },
})

const messagesTo = (fake) => fake.rowsOf('loan_messages')
  .filter((m) => m.author_role === 'assistant')
  .map((m) => m.body)

test('an upload reads itself, and the borrower is told which page is missing', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()

    // ── The prior month is already on file and already read ─────────────────
    await h.complete(uploadDone('d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d000'))
    await h.worker(tick())

    // ── Marcus finishes his upload. Nobody presses anything else. ───────────
    const done = await h.complete(uploadDone(DOC))
    const body = await done.json()
    assert.equal(done.status, 200, JSON.stringify(body))
    assert.equal(body.reading, true, 'the upload itself is what makes the read owed')

    // The read has NOT happened yet — the upload endpoint returns before a model is called,
    // which is the whole reason the queue exists.
    assert.equal(fake.rowsOf('document_extractions')
      .filter((e) => e.document_id === DOC).length, 0)
    const queued = fake.rowsOf('document_read_jobs').filter((j) => j.document_id === DOC)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].status, 'queued')
    assert.equal(queued[0].requested_by, 'borrower_upload')

    // ── One tick of the scheduler ───────────────────────────────────────────
    const ran = await h.worker(tick())
    assert.equal(ran.status, 200)
    const stats = await ran.json()
    assert.equal(stats.read, 1, JSON.stringify(stats))
    assert.equal(fake.rowsOf('document_read_jobs').find((j) => j.document_id === DOC).status, 'done')

    // ── What Marcus sees ────────────────────────────────────────────────────
    const said = messagesTo(fake)
    const latest = said[said.length - 1]
    assert.ok(latest, 'the borrower was told something')
    assert.match(latest, /pages 1–5 and 7/, latest)
    assert.match(latest, /Page 6 is still missing/, latest)
    assert.match(latest, /Chase Bank statement/, latest)
    // Nobody from WCCM was involved: the only human act was the upload.
    assert.equal(fake.rowsOf('portal_access_log')
      .filter((l) => l.portal_user === OWNER).length, 0)
    // …but the read is still on the record. A document opened with no audit entry at all is a
    // read nobody can account for a year from now; the null actor IS the "it was the system".
    const audited = fake.rowsOf('portal_access_log')
      .filter((l) => l.action === 'pre_underwriting_intake_auto')
    assert.equal(audited.length, 2, 'both automatic reads are audited')
    assert.ok(audited.every((l) => l.portal_user === null))
    assert.ok(audited.some((l) => String(l.target).startsWith(DOC)))
  } finally { restore() }
})

test('a second tick with nothing new says nothing', async () => {
  // A borrower who gets a message every minute stops reading them, and the one that mattered is
  // the one they skipped.
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    const after = messagesTo(fake).length
    await h.worker(tick())
    await h.worker(tick())
    assert.equal(messagesTo(fake).length, after, 'the worker repeated itself')
  } finally { restore() }
})

test('sending the missing page closes the loop without anyone asking again', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone('d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d000'))
    await h.worker(tick())
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    const askedForPage6 = messagesTo(fake).at(-1)
    assert.match(askedForPage6, /Page 6/)

    // Marcus re-sends the statement, this time whole. Same document row, new bytes — which is
    // what "replace this upload" does in the portal.
    const rows = fake.rowsOf('loan_documents')
    rows.find((d) => d.id === DOC).storage_path = 'f/whole.pdf'
    await h.complete(uploadDone(DOC))
    await h.worker(tick())

    // The old reading was superseded rather than left to argue with the new one.
    const live = fake.rowsOf('document_extractions')
      .filter((e) => e.document_id === DOC && !e.superseded_by)
    assert.equal(live.length, 1, 'exactly one live reading per document')

    const now = messagesTo(fake).at(-1)
    assert.ok(!/Page 6 is still missing/.test(now), now)
    assert.match(now, /we have read your/i)
  } finally { restore() }
})

test('a borrower is never told about something only the loan team can obtain', async () => {
  // The credit report is on every purchase checklist and no consumer can produce one. A message
  // asking for it is a message the borrower cannot act on.
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    for (const m of messagesTo(fake)) {
      assert.ok(!/credit report/i.test(m), m)
    }
  } finally { restore() }
})

test('a borrower message never carries a finding', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    // A live finding on the file, of the kind the rules produce.
    fake.rowsOf('pre_underwriting_findings').push({
      id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', loan_file_id: LOAN, rule: 'large_deposit',
      category: 'assets', severity: 'medium', status: 'pending_review',
      explanation: 'A deposit of $18,500 on the July statement needs sourcing',
      evidence: [], source_documents: ['bank_2mo'], superseded_by: null,
    })
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    for (const m of messagesTo(fake)) {
      for (const leak of ['18,500', 'sourcing', 'large_deposit', 'deposit']) {
        assert.ok(!m.includes(leak), `borrower message leaked "${leak}": ${m}`)
      }
    }
  } finally { restore() }
})

test('uploading twice reads the document once', async () => {
  // A double tap on a phone, or a retry after a flaky connection. Reading the same PDF twice
  // costs a model call and produces two extractions to reconcile.
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    const second = await h.complete(uploadDone(DOC))
    assert.equal(second.status, 200)
    assert.equal(fake.rowsOf('document_read_jobs').filter((j) => j.document_id === DOC).length, 1)
  } finally { restore() }
})

test('the worker is not a public endpoint', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    // No schedule marker and no operator key: the only two ways in.
    const anon = await h.worker(makeRequest('https://a/pre-underwriting-read-worker', {
      method: 'POST', body: { drain: true },
    }))
    assert.equal(anon.status, 404)
    assert.equal(fake.rowsOf('document_read_jobs').find((j) => j.document_id === DOC).status, 'queued')

    const wrongKey = new Request('https://a/pre-underwriting-read-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ourmtg-worker-key': 'not-the-key' },
      body: JSON.stringify({}),
    })
    assert.equal((await h.worker(wrongKey)).status, 404)

    const withKey = new Request('https://a/pre-underwriting-read-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ourmtg-worker-key': 'worker-key-for-tests' },
      body: JSON.stringify({}),
    })
    assert.equal((await h.worker(withKey)).status, 200)
  } finally { restore() }
})

test('a document removed before the worker reaches it fails the job instead of retrying', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    fake.rowsOf('loan_documents').find((d) => d.id === DOC).reject_reason = '__REMOVED__:borrower'
    await h.worker(tick())
    const job = fake.rowsOf('document_read_jobs').find((j) => j.document_id === DOC)
    assert.equal(job.status, 'failed')
    assert.equal(job.last_error_code, 'document_gone')
    // And nothing was said to the borrower about a document they withdrew.
    assert.equal(messagesTo(fake).length, 0)
  } finally { restore() }
})

// ── the audit trail ─────────────────────────────────────────────────────────
// Nobody is watching this run. The only way anyone reconstructs what it did — or answers a
// borrower asking "why did nobody tell me?" — is the record it leaves behind, and a decision to
// stay silent is exactly as much a decision as a decision to write.

const auditOf = (fake, action) => fake.rowsOf('portal_access_log').filter((l) => l.action === action)

test('every automatic read leaves a record, whatever its outcome', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    const reads = auditOf(fake, 'pre_underwriting_intake_auto')
    assert.equal(reads.length, 1)
    assert.equal(reads[0].portal_user, null, 'the null actor IS the record that it was the system')
    assert.equal(reads[0].loan_file_id, LOAN)
    assert.match(String(reads[0].target), new RegExp(`^${DOC}:read$`))
  } finally { restore() }
})

test('a read that never happened is still recorded as attempted', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    fake.rowsOf('loan_documents').find((d) => d.id === DOC).reject_reason = '__REMOVED__:borrower'
    await h.worker(tick())
    const reads = auditOf(fake, 'pre_underwriting_intake_auto')
    assert.equal(reads.length, 1, 'an attempt with no record is indistinguishable from no attempt')
    assert.match(String(reads[0].target), /document_gone$/)
  } finally { restore() }
})

test('a borrower message that IS sent is recorded', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    const sent = auditOf(fake, 'borrower_followup_sent')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].portal_user, null)
    assert.match(String(sent[0].target), new RegExp(`^${DOC}:sent:\\d+$`))
    // And the message itself is on the file, so the two agree.
    assert.equal(messagesTo(fake).length, 1)
  } finally { restore() }
})

test('a borrower message that is SUPPRESSED is recorded, with the reason', async () => {
  // The half that is easy to leave out and impossible to reconstruct later.
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone(DOC))
    await h.worker(tick())
    const before = messagesTo(fake).length

    // A second identical run: nothing changed, so nothing is said — and that is minuted.
    fake.rowsOf('document_read_jobs').find((j) => j.document_id === DOC).status = 'queued'
    await h.worker(tick())

    assert.equal(messagesTo(fake).length, before, 'the borrower must not be told twice')
    const suppressed = auditOf(fake, 'borrower_followup_suppressed')
    assert.equal(suppressed.length, 1, 'silence must be minuted')
    assert.match(String(suppressed[0].target), new RegExp(`^${DOC}:unchanged$`))
    assert.equal(suppressed[0].portal_user, null)
  } finally { restore() }
})

test('every tick accounts for itself: a read, a message decision, or both', async () => {
  const fake = world()
  const restore = install(fake)
  try {
    const h = await handlers()
    await h.complete(uploadDone('d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d000'))
    await h.complete(uploadDone(DOC))
    await h.worker(tick())

    const reads = auditOf(fake, 'pre_underwriting_intake_auto').length
    const decisions = auditOf(fake, 'borrower_followup_sent').length
      + auditOf(fake, 'borrower_followup_suppressed').length
    assert.equal(reads, 2, 'both documents were read, and both reads are on the record')
    assert.equal(decisions, 2, 'each read reached a message decision, and each decision is minuted')
  } finally { restore() }
})
