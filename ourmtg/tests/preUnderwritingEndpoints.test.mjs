// Autopilot Pre-Underwriting — endpoint tests.
//
// These drive the real handlers over the in-memory Supabase stand-in, with a stubbed model, so
// the repo layer, the contract, the rule engine and the panel assembly all actually run.
//
// What they prove, in order of how badly it would hurt to get wrong:
//   • findings never leave the building — a borrower cannot reach them by any route
//   • no endpoint can express an approval, and none accepts one
//   • only the borrower can authorize a credit pull, including against the file's owner
//   • a human decision survives a re-run; a pending finding does not
//   • a model failure loses nothing that was uploaded

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'
import { CREDIT_AUTH_VERSION } from '../src/features/pre-underwriting/creditAuthorization.js'

const LOAN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BORROWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REALTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DOC = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'

const USERS = {
  'tok-owner': { id: OWNER, email: 'lo@wcc.com', aud: 'authenticated' },
  'tok-borrower': { id: BORROWER, email: 'daria@example.com', aud: 'authenticated' },
  'tok-realtor': { id: REALTOR, email: 'agent@example.com', aud: 'authenticated' },
}

const TABLES = () => ({
  loan_files: [
    { id: LOAN, owner_user_id: OWNER, organization_id: 'org-1', borrower_name: 'Daria N', stage: 'application', loan_purpose: 'purchase' },
    { id: OTHER, owner_user_id: OWNER, organization_id: 'org-1', borrower_name: 'Someone Else', stage: 'lead' },
  ],
  portal_access: [
    { portal_user: BORROWER, loan_file_id: LOAN, visibility: 'borrower' },
    { portal_user: REALTOR, loan_file_id: LOAN, visibility: 'realtor' },
  ],
  portal_team: [],
  portal_access_log: [],
  loan_documents: [
    { id: DOC, loan_file_id: LOAN, owner_user_id: OWNER, doc_key: 'bank_2mo', label: 'Bank statements', status: 'uploaded', storage_path: 'files/bank.pdf', who: 'borrower' },
  ],
  document_extractions: [],
  pre_underwriting_findings: [],
  credit_authorizations: [],
  mortgage_applications: [],
  application_field_state: [],
})

// A model that reads a bank statement and a credit report. Deliberately returns a tradeline the
// application does not declare, so undisclosed_liability actually fires.
const MODEL_REPLY = (over = {}) => ({
  stop_reason: 'end_turn',
  model: 'claude-opus-5',
  usage: { input_tokens: 900, output_tokens: 120 },
  content: [{ type: 'text', text: JSON.stringify({
    docKey: 'bank_2mo', docKeyConfidence: 0.97,
    fields: [
      { name: 'statementMonth', value: '2026-07', confidence: 0.98 },
      { name: 'endingBalance', value: '$12,400.00', confidence: 0.96 },
      { name: 'accountHolder', value: 'Daria N', confidence: 0.94 },
    ],
    ...over,
  }) }],
})

function stubModel(reply = MODEL_REPLY()) {
  const calls = []
  return Object.assign(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) }
  }, { calls })
}

let bust = 0
async function load(env = {}) {
  setTestEnv({
    PRE_UNDERWRITING_ENABLED: 'true',
    CONVERSATIONAL_1003_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'test-key-not-real',
    OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock',
    OURMTG_ALLOW_MOCK_SCAN: 'true',
    OURMTG_MOCK_SCAN_STATUS: 'clean',
    ...env,
  })
  bust++
  const q = `?t=${bust}`
  return {
    intake: (await import(`../netlify/functions/pre-underwriting-intake.mjs${q}`)).default,
    review: (await import(`../netlify/functions/pre-underwriting-review.mjs${q}`)).default,
    credit: (await import(`../netlify/functions/credit-authorization.mjs${q}`)).default,
  }
}

/**
 * Install the fake. Supabase traffic and Anthropic traffic share global fetch, so they are
 * routed by hostname — the alternative is a model stub that answers database queries.
 */
function install(fake, model) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const s = String(url)
    if (s.includes('api.anthropic.com')) return model ? model(url, opts) : original(url, opts)
    return fake.fetch(url, opts)
  }
  return () => { globalThis.fetch = original }
}

const key = (s) => `t.${s}.${Math.random().toString(36).slice(2, 10)}`
const panelUrl = (id = LOAN) => `https://app.test/.netlify/functions/pre-underwriting-review?loanFileId=${id}`
const post = (body, token = 'tok-owner') => makeRequest('https://app.test/x', { method: 'POST', token, body })

function withDoc(fake) {
  fake.putFile('files/bank.pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf')
  return fake
}

// ── the boundary ────────────────────────────────────────────────────────────

test('the feature is default-off and nothing is read or written while it is', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load({ PRE_UNDERWRITING_ENABLED: 'false' })
    for (const res of [
      await h.review(makeRequest(panelUrl(), { token: 'tok-owner' })),
      await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('a') })),
      await h.credit(makeRequest(`https://app.test/x?loanFileId=${LOAN}`, { token: 'tok-borrower' })),
    ]) assert.equal(res.status, 404)
    assert.equal(fake.calls.filter((c) => c.path.startsWith('/rest/')).length, 0)
  } finally { restore() }
})

test('a borrower cannot reach findings, and neither can a realtor', async () => {
  // The single most important assertion in this file. Findings characterize the applicant; the
  // boundary doc says they stay inside until a human releases them.
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    for (const token of ['tok-borrower', 'tok-realtor']) {
      assert.equal((await h.review(makeRequest(panelUrl(), { token }))).status, 403, token)
      assert.equal((await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('x') }, token))).status, 403, token)
    }
  } finally { restore() }
})

test('a document belonging to another file cannot be read through this one', async () => {
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const restore = install(fake, stubModel())
  try {
    const h = await load()
    const res = await h.intake(post({ loanFileId: OTHER, documentId: DOC, idempotencyKey: key('cross') }))
    assert.equal(res.status, 404)
    assert.equal(fake.rowsOf('document_extractions').length, 0)
  } finally { restore() }
})

// ── reading a document ──────────────────────────────────────────────────────

test('reading a document stores the extraction and re-runs every rule', async () => {
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const model = stubModel()
  const restore = install(fake, model)
  try {
    const h = await load()
    const res = await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('read') }))
    assert.equal(res.status, 200)
    const body = await res.json()

    assert.equal(body.extraction.docKey, 'bank_2mo')
    assert.equal(body.extraction.fieldCount, 3)
    assert.equal(body.extraction.needsHumanReview, false)

    const stored = fake.rowsOf('document_extractions')
    assert.equal(stored.length, 1)
    assert.equal(stored[0].doc_key, 'bank_2mo')
    // The value was coerced by the contract, not passed through as the model's string.
    assert.equal(stored[0].fields.fields.find((f) => f.name === 'endingBalance').value, 12400)

    // The document actually reached the model, as a document block before the text.
    assert.equal(model.calls.length, 1)
    assert.equal(model.calls[0].body.messages[0].content[0].type, 'document')
    // And nothing about the borrower travelled with it.
    const sent = JSON.stringify(model.calls[0].body).toLowerCase()
    assert.ok(!sent.includes('daria'), 'the borrower name must not be sent with the document')
  } finally { restore() }
})

test('a re-read supersedes the old one rather than doubling the file', async () => {
  // Otherwise name_consistency fires because the borrower "appears twice" — both times on the
  // same piece of paper.
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const restore = install(fake, stubModel())
  try {
    const h = await load()
    await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('r1') }))
    await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('r2') }))

    const rows = fake.rowsOf('document_extractions')
    assert.equal(rows.length, 2, 'history is kept')
    assert.equal(rows.filter((r) => !r.superseded_by).length, 1, 'only one is live')
  } finally { restore() }
})

test('an unreadable upload fails with something a person can act on, and loses nothing', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  fake.putFile('files/bank.pdf', Buffer.from('fake'), 'image/heic')
  const restore = install(fake, stubModel())
  try {
    const h = await load()
    const res = await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('heic') }))
    assert.equal(res.status, 422)
    const body = await res.json()
    assert.equal(body.code, 'unsupported_file_content')
    assert.match(body.error, /supported PDF/i)
    // The document is untouched and still on the file, waiting.
    assert.equal(fake.rowsOf('loan_documents')[0].status, 'uploaded')
    assert.equal(fake.rowsOf('document_extractions').length, 0)
  } finally { restore() }
})

test('a provider outage is a 502 and the upload survives it', async () => {
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const dead = async () => { throw new Error('ECONNRESET') }
  const restore = install(fake, dead)
  try {
    const h = await load()
    const res = await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('down') }))
    assert.equal(res.status, 502)
    assert.equal(fake.rowsOf('document_extractions').length, 0)
    assert.equal(fake.rowsOf('loan_documents').length, 1)
  } finally { restore() }
})

test('a model that invents a document type stores no fields at all', async () => {
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const restore = install(fake, stubModel({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({
      docKey: 'crypto_statement', docKeyConfidence: 1,
      fields: [{ name: 'endingBalance', value: 999999, confidence: 1 }],
    }) }],
  }))
  try {
    const h = await load()
    const body = await (await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('inv') }))).json()
    assert.equal(body.extraction.docKey, null)
    assert.equal(body.extraction.proposedDocKey, 'crypto_statement')
    assert.equal(body.extraction.fieldCount, 0)
    assert.equal(body.extraction.needsHumanReview, true)
  } finally { restore() }
})

test('a complete tax-return package persists and reaches the internal source-linked income report', async () => {
  const tables = TABLES()
  tables.loan_documents[0] = {
    ...tables.loan_documents[0], doc_key: 'tax_return_full', label: 'Complete tax returns',
    storage_path: 'files/tax-return.pdf',
  }
  const fake = createFakeSupabase({ tables, users: USERS })
  fake.putFile('files/tax-return.pdf', Buffer.from('%PDF-1.4 tax package'), 'application/pdf')
  const model = stubModel(MODEL_REPLY({
    docKey: 'tax_return_full', docKeyConfidence: 0.99,
    fields: [
      { name: 'pagesPresent', value: 20, confidence: 0.99 },
      { name: 'pagesTotal', value: 20, confidence: 0.99 },
    ],
    taxForms: [
      { formType: '1040', taxYear: 2024, taxpayerName: 'Daria N', pageStart: 1, pageEnd: 2, confidence: 0.99 },
      { formType: '1040', taxYear: 2025, taxpayerName: 'Daria N', pageStart: 11, pageEnd: 12, confidence: 0.99 },
    ],
    taxLineItems: [
      { lineKey: 'form1040_wages', formType: '1040', taxYear: 2024, amount: 100000, taxpayerName: 'Daria N', page: 1, lineLabel: 'Wages, salaries, tips', confidence: 0.98 },
      { lineKey: 'form1040_wages', formType: '1040', taxYear: 2025, amount: 120000, taxpayerName: 'Daria N', page: 11, lineLabel: 'Wages, salaries, tips', confidence: 0.98 },
    ],
  }))
  const restore = install(fake, model)
  try {
    const h = await load()
    const read = await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('tax') }))
    assert.equal(read.status, 200)
    const readBody = await read.json()
    assert.equal(readBody.extraction.docKey, 'tax_return_full')
    assert.equal(readBody.extraction.taxFormCount, 2)
    assert.equal(readBody.extraction.taxLineItemCount, 2)

    const stored = fake.rowsOf('document_extractions')[0]
    assert.equal(stored.fields.taxForms.length, 2)
    assert.equal(stored.fields.taxLineItems.length, 2)
    assert.equal(stored.fields.taxLineItems[1].amount, 120000)

    const panel = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()
    assert.equal(panel.audience, 'team')
    assert.equal(panel.taxIncome.status, 'prepared_for_review')
    assert.equal(panel.taxIncome.comparison.calculatedAnnual, 110000)
    assert.equal(panel.taxIncome.comparison.calculatedMonthly, 9166.67)
    assert.equal(panel.taxIncome.qualifyingIncome.monthly, null)
    assert.equal(panel.taxIncome.years[1].sources[0].evidence[0].page, 11)
  } finally { restore() }
})

// ── the panel ───────────────────────────────────────────────────────────────

test('the panel assembles readiness, missing, findings and programs', async () => {
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const restore = install(fake, stubModel())
  try {
    const h = await load()
    await h.intake(post({ loanFileId: LOAN, documentId: DOC, idempotencyKey: key('p') }))
    const panel = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()

    assert.equal(typeof panel.readiness.percent, 'number')
    assert.ok(panel.readiness.notMeaning.some((n) => n.includes('approval')))
    // Missing is split by who can actually send it — a processor chasing a borrower for a credit
    // report is a wasted day, and a borrower asked for one cannot comply.
    assert.ok(Array.isArray(panel.missing.borrower))
    assert.ok(panel.missing.loanTeam.some((m) => m.docKey === 'credit_report'))
    assert.ok(!panel.missing.borrower.some((m) => m.docKey === 'credit_report'))
    // Programs are suitability, and say what was not examined.
    assert.ok(panel.programs.suitable.length > 0)
    assert.ok(panel.programs.notChecked.some((n) => /automated underwriting/i.test(n)))
    assert.equal(panel.audience, 'team')
  } finally { restore() }
})

test('a document uploaded but never read is named, not silently skipped', async () => {
  // A panel that omitted these would be claiming a completeness it has not checked.
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const restore = install(fake, stubModel())
  try {
    const h = await load()
    const panel = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()
    assert.deepEqual(panel.unread.map((u) => u.id), [DOC])
  } finally { restore() }
})

test('no endpoint accepts an approval, by any name', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    for (const action of ['approve', 'deny', 'approve_loan', 'clear', 'accept']) {
      const res = await h.review(post({ loanFileId: LOAN, action, idempotencyKey: key(action) }))
      assert.equal(res.status, 400, action)
      assert.equal((await res.json()).error, 'Invalid action')
    }
  } finally { restore() }
})

// ── the human decision ──────────────────────────────────────────────────────

async function fileWithFinding(fake, h) {
  fake.rowsOf('pre_underwriting_findings').push({
    id: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    loan_file_id: LOAN, rule: 'income_consistency', category: 'income', severity: 'high',
    explanation: 'periods differ', evidence: [], source_documents: ['paystubs_30d'],
    min_confidence: 0.8, needs_human_review: true, status: 'pending_review',
    superseded_by: null, created_at: '2026-08-01T00:00:00Z',
  })
  return 'ffffffff-ffff-4fff-8fff-fffffffffff1'
}

test('confirming, correcting and dismissing all record who decided', async () => {
  for (const [action, status] of [['confirm', 'confirmed'], ['correct', 'corrected'], ['dismiss', 'dismissed']]) {
    const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
    const restore = install(fake)
    try {
      const h = await load()
      const id = await fileWithFinding(fake, h)
      const res = await h.review(post({
        loanFileId: LOAN, findingId: id, action, idempotencyKey: key(action),
        note: 'checked with the borrower',
        ...(action === 'correct' ? { correctedFields: [{ field: 'grossPay', value: '4200' }] } : {}),
      }))
      assert.equal(res.status, 200, action)
      const row = fake.rowsOf('pre_underwriting_findings')[0]
      assert.equal(row.status, status)
      assert.equal(row.resolved_by, OWNER)
      assert.ok(row.resolved_at)
    } finally { restore() }
  }
})

test('a dismissal without a reason is refused', async () => {
  // It is the decision that cannot be defended when somebody asks about it a year later.
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const id = await fileWithFinding(fake, h)
    const res = await h.review(post({ loanFileId: LOAN, findingId: id, action: 'dismiss', idempotencyKey: key('d') }))
    assert.equal(res.status, 400)
    assert.equal(fake.rowsOf('pre_underwriting_findings')[0].status, 'pending_review')
  } finally { restore() }
})

test('a correction without a value is refused', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const id = await fileWithFinding(fake, h)
    const res = await h.review(post({ loanFileId: LOAN, findingId: id, action: 'correct', idempotencyKey: key('c') }))
    assert.equal(res.status, 400)
  } finally { restore() }
})

test('two processors cannot both decide the same finding', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const id = await fileWithFinding(fake, h)
    assert.equal((await h.review(post({ loanFileId: LOAN, findingId: id, action: 'confirm', idempotencyKey: key('1') }))).status, 200)
    const second = await h.review(post({ loanFileId: LOAN, findingId: id, action: 'dismiss', note: 'no', idempotencyKey: key('2') }))
    assert.equal(second.status, 409)
    assert.equal((await second.json()).code, 'already_reviewed')
    // The first decision stands.
    assert.equal(fake.rowsOf('pre_underwriting_findings')[0].status, 'confirmed')
  } finally { restore() }
})

test('a human decision survives a re-run; a pending finding does not', async () => {
  // Re-raising something a person already dismissed is how a reviewer learns to ignore the panel.
  const fake = withDoc(createFakeSupabase({ tables: TABLES(), users: USERS }))
  const restore = install(fake, stubModel())
  try {
    const h = await load()
    const id = await fileWithFinding(fake, h)
    await h.review(post({ loanFileId: LOAN, findingId: id, action: 'dismiss', note: 'bonus year', idempotencyKey: key('dis') }))

    await h.review(post({ loanFileId: LOAN, action: 'reanalyse', idempotencyKey: key('re') }))

    const live = fake.rowsOf('pre_underwriting_findings').filter((r) => !r.superseded_by)
    const income = live.find((r) => r.rule === 'income_consistency')
    assert.ok(income, 'the decided finding is still there')
    assert.equal(income.status, 'dismissed')
    assert.equal(income.resolution_note, 'bonus year')
  } finally { restore() }
})

// ── credit authorization ────────────────────────────────────────────────────

const authUrl = (id = LOAN) => `https://app.test/.netlify/functions/credit-authorization?loanFileId=${id}`

test('only the borrower can authorize a credit pull — not even the file owner', async () => {
  // Under the FCRA the permissible purpose rests on the consumer authorizing it. An
  // authorization recorded by the person who benefits from it is not one.
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const res = await h.credit(post({
      loanFileId: LOAN, accepted: true, documentVersion: CREDIT_AUTH_VERSION,
      presentedAt: new Date().toISOString(), idempotencyKey: key('lo'),
    }, 'tok-owner'))
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, 'borrower_only')
    assert.equal(fake.rowsOf('credit_authorizations').length, 0)
  } finally { restore() }
})

test('the borrower authorizes, and what is stored is what they were shown', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const presentedAt = new Date(Date.now() - 20_000).toISOString()
    const res = await h.credit(post({
      loanFileId: LOAN, accepted: true, documentVersion: CREDIT_AUTH_VERSION,
      presentedAt, idempotencyKey: key('ok'),
    }, 'tok-borrower'))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.authorized, true)
    assert.ok(body.notMeaning.some((n) => n.includes('pre-approval')))

    const row = fake.rowsOf('credit_authorizations')[0]
    assert.equal(row.document_version, CREDIT_AUTH_VERSION)
    assert.equal(row.accepted_by, BORROWER)
    assert.equal(row.presented_at, presentedAt)
    assert.ok(row.accepted_at >= row.presented_at, 'acceptance cannot precede presentation')
  } finally { restore() }
})

test('an acceptance echoing the wrong wording version is refused', async () => {
  // The page was open across a wording change; storing it would record consent to text nobody saw.
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const res = await h.credit(post({
      loanFileId: LOAN, accepted: true, documentVersion: '2019.old',
      presentedAt: new Date().toISOString(), idempotencyKey: key('old'),
    }, 'tok-borrower'))
    assert.equal(res.status, 409)
    assert.equal(fake.rowsOf('credit_authorizations').length, 0)
  } finally { restore() }
})

test('the team can see whether permission exists but never the evidence behind it', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    await h.credit(post({
      loanFileId: LOAN, accepted: true, documentVersion: CREDIT_AUTH_VERSION,
      presentedAt: new Date().toISOString(), idempotencyKey: key('e'),
    }, 'tok-borrower'))

    const seen = await (await h.credit(makeRequest(authUrl(), { token: 'tok-owner' }))).json()
    assert.equal(seen.authorized, true)
    assert.equal(seen.canAuthorize, false)
    // IP and user agent are evidence of consent, not operational data.
    const serialized = JSON.stringify(seen)
    assert.ok(!serialized.includes('user_agent') && !serialized.includes('"ip"'))
  } finally { restore() }
})

test('a realtor cannot see whether the borrower authorized a credit pull', async () => {
  // Not a milestone. It is a fact about somebody's consumer file.
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    assert.equal((await h.credit(makeRequest(authUrl(), { token: 'tok-realtor' }))).status, 403)
  } finally { restore() }
})

test('the borrower can withdraw permission, and the record still says it happened', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    await h.credit(post({
      loanFileId: LOAN, accepted: true, documentVersion: CREDIT_AUTH_VERSION,
      presentedAt: new Date().toISOString(), idempotencyKey: key('a'),
    }, 'tok-borrower'))
    const res = await h.credit(post({ loanFileId: LOAN, revoke: true, idempotencyKey: key('r') }, 'tok-borrower'))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).authorized, false)

    const row = fake.rowsOf('credit_authorizations')[0]
    assert.ok(row.revoked_at, 'stamped, not deleted — the authorization did happen')
    assert.equal(row.accepted_by, BORROWER)

    const panel = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()
    assert.equal(panel.credit.authorized, false)
    assert.match(panel.credit.gap.explanation, /authorization/i)
  } finally { restore() }
})

test('the panel tells the loan officer credit is missing without offering to authorize it', async () => {
  const fake = createFakeSupabase({ tables: TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load()
    const panel = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()
    assert.equal(panel.credit.authorized, false)
    assert.equal(panel.credit.reason, 'not_authorized')
    assert.equal(panel.credit.gap.owner, 'loan_team')
    assert.equal(panel.credit.documentVersion, CREDIT_AUTH_VERSION)
  } finally { restore() }
})

// ── credit liabilities → the 1003 ───────────────────────────────────────────

const CR_DOC = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd9'

const CREDIT_REPLY = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({
    docKey: 'credit_report', docKeyConfidence: 0.99,
    fields: [
      { name: 'equifaxScore', value: 700, confidence: 0.99 },
      { name: 'experianScore', value: 710, confidence: 0.99 },
      { name: 'transUnionScore', value: 705, confidence: 0.99 },
    ],
    tradelines: [
      { creditorName: 'Discover', accountType: 'Revolving', monthlyPayment: 320, balance: 8100, accountLast4: '9001', status: 'Open', confidence: 0.95 },
      { creditorName: 'Navient', accountType: 'Education', monthlyPayment: 0, balance: 61000, accountLast4: '7001', status: 'Deferred', confidence: 0.92 },
      { creditorName: 'Old Navy', accountType: 'Revolving', monthlyPayment: 0, balance: 0, accountLast4: '1111', status: 'Closed - paid', confidence: 0.9 },
    ],
  }) }],
}

function creditTables() {
  const t = TABLES()
  t.loan_documents.push({
    id: CR_DOC, loan_file_id: LOAN, owner_user_id: OWNER, doc_key: 'credit_report',
    label: 'Credit report', status: 'uploaded', storage_path: 'files/credit.pdf', who: 'borrower',
  })
  t.application_parties = []
  t.application_field_events = []
  t.application_turns = []
  return t
}

test('import writes the missing obligations into the 1003 through the reducer, as imported_credit', async () => {
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  fake.putFile('files/credit.pdf', Buffer.from('%PDF-1.4 CREDIT'), 'application/pdf')
  const restore = install(fake, stubModel(CREDIT_REPLY))
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    await h.intake(post({ loanFileId: LOAN, documentId: CR_DOC, idempotencyKey: key('cr') }))

    const res = await h.review(post({ loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('imp') }))
    assert.equal(res.status, 200)
    const body = await res.json()

    // Discover and the deferred Navient import; the closed Old Navy does not.
    assert.deepEqual(body.result.imported.map((i) => i.creditorName).sort(), ['Discover', 'Navient'])
    assert.equal(body.result.skipped.length, 1)
    assert.equal(body.result.needsPayment.length, 1)
    assert.equal(body.result.needsPayment[0].creditorName, 'Navient')

    const events = fake.rowsOf('application_field_events')
    assert.ok(events.length > 0)
    for (const e of events) {
      assert.equal(e.source, 'imported_credit', e.field_path)
      assert.equal(e.actor_user_id, OWNER)
    }
    // The section gate answered, the fields written, and no account number anywhere.
    const paths = events.map((e) => e.field_path)
    assert.ok(paths.includes('parties[0].hasAnyLiabilities'))
    assert.ok(paths.includes('parties[0].liabilities[0].creditorName'))
    assert.ok(!paths.some((p) => /accountNumber/.test(p)))
    const dump = JSON.stringify(events)
    assert.ok(!dump.includes('9001') || !dump.includes('accountNumber'), 'no account digits under a number field')
  } finally { restore() }
})

test('importing twice is a no-op the second time, not a duplicate section', async () => {
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  fake.putFile('files/credit.pdf', Buffer.from('%PDF-1.4 CREDIT'), 'application/pdf')
  const restore = install(fake, stubModel(CREDIT_REPLY))
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    await h.intake(post({ loanFileId: LOAN, documentId: CR_DOC, idempotencyKey: key('cr2') }))
    const first = await (await h.review(post({ loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('i1') }))).json()
    assert.equal(first.result.imported.length, 2)

    const second = await (await h.review(post({ loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('i2') }))).json()
    assert.equal(second.result.imported.length, 0, JSON.stringify(second.result))

    // Still exactly one creditorName row per creditor in the projection.
    const state = fake.rowsOf('application_field_state')
    const creditorRows = state.filter((s) => /liabilities\[\d+\]\.creditorName/.test(s.field_path))
    assert.equal(creditorRows.length, 2)
  } finally { restore() }
})

test('the panel shows the reconciliation before anything is written', async () => {
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  fake.putFile('files/credit.pdf', Buffer.from('%PDF-1.4 CREDIT'), 'application/pdf')
  const restore = install(fake, stubModel(CREDIT_REPLY))
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    await h.intake(post({ loanFileId: LOAN, documentId: CR_DOC, idempotencyKey: key('cr3') }))
    const panel = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()

    assert.ok(panel.liabilitySync, 'reconciliation is on the panel')
    assert.deepEqual(panel.liabilitySync.toImport.map((t) => t.creditorName).sort(), ['Discover', 'Navient'])
    assert.equal(panel.liabilitySync.skipped[0].creditorName, 'Old Navy')
    assert.ok(panel.liabilitySync.toImport.find((t) => t.creditorName === 'Navient').needsPayment)
  } finally { restore() }
})

test('after the import, undisclosed_liability findings clear on the same response', async () => {
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  fake.putFile('files/credit.pdf', Buffer.from('%PDF-1.4 CREDIT'), 'application/pdf')
  const restore = install(fake, stubModel(CREDIT_REPLY))
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    await h.intake(post({ loanFileId: LOAN, documentId: CR_DOC, idempotencyKey: key('cr4') }))

    const before = await (await h.review(makeRequest(panelUrl(), { token: 'tok-owner' }))).json()
    assert.ok(before.findings.some((f) => f.rule.startsWith('undisclosed_liability')), 'fires while undeclared')

    const after = await (await h.review(post({ loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('i3') }))).json()
    const live = after.findings.filter((f) => f.rule.startsWith('undisclosed_liability') && f.status === 'pending_review')
    assert.deepEqual(live, [], 'cleared once the 1003 knows about the debts')
  } finally { restore() }
})

test('an import with no credit report on file is refused with a reason', async () => {
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  const restore = install(fake)
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    const res = await h.review(post({ loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('no') }))
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /No credit report/)
  } finally { restore() }
})

test('an attested application is not silently modified by an import', async () => {
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  fake.putFile('files/credit.pdf', Buffer.from('%PDF-1.4 CREDIT'), 'application/pdf')
  fake.rowsOf('mortgage_applications').push({
    id: '99999999-9999-4999-8999-999999999999', loan_file_id: LOAN, application_version: 1,
    status: 'borrower_attested', schema_version: 'v', catalog_version: 'v', rules_version: 'v',
  })
  const restore = install(fake, stubModel(CREDIT_REPLY))
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    await h.intake(post({ loanFileId: LOAN, documentId: CR_DOC, idempotencyKey: key('cr5') }))
    const res = await h.review(post({ loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('att') }))
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /submitted/)
    assert.equal(fake.rowsOf('application_field_events').length, 0)
  } finally { restore() }
})

test('the borrower-reachable surface never carries document contents', async () => {
  // NEVER_ECHOED's enforcement is structural: extraction values only travel on internal-only
  // endpoints. This pins the one borrower-reachable endpoint in the feature to that guarantee —
  // if someone ever adds extraction data to it, this is the test that goes red.
  const fake = createFakeSupabase({ tables: creditTables(), users: USERS })
  fake.putFile('files/credit.pdf', Buffer.from('%PDF-1.4 CREDIT'), 'application/pdf')
  const restore = install(fake, stubModel(CREDIT_REPLY))
  try {
    const h = await load({ CONVERSATIONAL_1003_ENABLED: 'true' })
    await h.intake(post({ loanFileId: LOAN, documentId: CR_DOC, idempotencyKey: key('ne') }))

    const res = await h.credit(makeRequest(authUrl(), { token: 'tok-borrower' }))
    assert.equal(res.status, 200)
    const body = JSON.stringify(await res.json())
    // Nothing read out of any document — no scores, no creditors, no balances.
    for (const leak of ['equifax', '700', 'Discover', 'Navient', 'tradeline', 'fields']) {
      assert.ok(!body.includes(leak), `borrower response carries "${leak}"`)
    }
  } finally { restore() }
})
