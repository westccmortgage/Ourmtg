// One file's whole journey, driven through the REAL handlers end to end.
//
// The per-endpoint tests all pass and have already been wrong together once: each slice was
// individually correct while the panel ran on an empty application, because nothing ever tested
// the STORY — answers recorded on the 1003, documents read, numbers derived, liabilities
// imported back into the application, a human deciding, and the file surviving a re-run.
//
// This is that story, as one scenario. Every assertion here is something a loan officer would
// notice on the screen if it broke, which is the definition of "логика не до конца правильно".
//
//   Daria is buying a house for $620,000 with a $496,000 loan.
//   She declared ONE debt on her application: her Chase card.
//   Her credit report shows FOUR tradelines:
//     Chase Card        $185/mo   — declared, must match, must NOT be re-imported
//     Discover          $340/mo   — undisclosed, must produce a finding and an import row
//     Dept of Education $0 (bal $24,000) — deferred student loan: $0 is not "free", import + flag
//     Old Navy          closed, $0 balance — not a liability, must be skipped, never imported
//
// If the logic is right, the numbers on the panel are exactly computable by hand. They are
// asserted by hand below.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'
import { CREDIT_AUTH_VERSION } from '../src/features/pre-underwriting/creditAuthorization.js'

const LOAN = '11111111-1111-4111-8111-111111111111'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BORROWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const USERS = {
  'tok-owner': { id: OWNER, email: 'lo@wcc.com', aud: 'authenticated' },
  'tok-borrower': { id: BORROWER, email: 'daria@example.com', aud: 'authenticated' },
}

// Six uploads: two bank statements share a doc_key, which is exactly the case that breaks
// naive "one extraction per key" logic.
const DOCS = {
  paystub: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd001', doc_key: 'paystubs_30d', path: 'f/stub.pdf', tag: 'STUB' },
  w2: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd002', doc_key: 'w2_2yr', path: 'f/w2.pdf', tag: 'W2' },
  bankJun: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd003', doc_key: 'bank_2mo', path: 'f/jun.pdf', tag: 'JUNE' },
  bankJul: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd004', doc_key: 'bank_2mo', path: 'f/jul.pdf', tag: 'JULY' },
  credit: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd005', doc_key: 'credit_report', path: 'f/credit.pdf', tag: 'CREDIT' },
  id: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd006', doc_key: 'id_photo', path: 'f/id.png', tag: 'IDFRONT' },
  contract: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddd007', doc_key: 'purchase_contract', path: 'f/psa.pdf', tag: 'PSA' },
}

const ym = (offsetMonths) => {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() + offsetMonths)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
const LAST_MONTH = ym(-1)
const THIS_MONTH = ym(0)

// What the model "reads" out of each document. Routed by the file's own bytes — the stub decodes
// the base64 the endpoint actually sent, so this also proves the right file reaches the model.
const READINGS = {
  STUB: {
    docKey: 'paystubs_30d', docKeyConfidence: 0.98,
    fields: [
      { name: 'employeeName', value: 'Daria N', confidence: 0.96 },
      { name: 'grossPay', value: '$4,200.00', confidence: 0.97 },
      { name: 'payFrequency', value: 'semi-monthly', confidence: 0.95 },
      { name: 'payPeriodStart', value: iso(33), confidence: 0.95 },
      { name: 'payPeriodEnd', value: iso(3), confidence: 0.95 },
      { name: 'periodEnd', value: iso(3), confidence: 0.95 },
    ],
  },
  W2: {
    docKey: 'w2_2yr', docKeyConfidence: 0.98,
    fields: [
      { name: 'taxYear', value: 2025, confidence: 0.98 },
      { name: 'employeeName', value: 'Daria N', confidence: 0.95 },
      // 100,800 / 12 = 8,400 — deliberately identical to the stub's monthly, so a false
      // income_consistency here means the comparison logic broke, not the data.
      { name: 'wagesTipsOther', value: 100800, confidence: 0.97 },
    ],
  },
  JUNE: {
    docKey: 'bank_2mo', docKeyConfidence: 0.97,
    fields: [
      { name: 'accountHolder', value: 'Daria N', confidence: 0.95 },
      { name: 'statementMonth', value: LAST_MONTH, confidence: 0.97 },
      { name: 'statementEnd', value: `${LAST_MONTH}-28`, confidence: 0.97 },
      { name: 'pagesPresent', value: 6, confidence: 0.95 }, { name: 'pagesTotal', value: 6, confidence: 0.95 },
      { name: 'endingBalance', value: '$41,204.55', confidence: 0.96 },
    ],
  },
  JULY: {
    docKey: 'bank_2mo', docKeyConfidence: 0.97,
    fields: [
      { name: 'accountHolder', value: 'Daria N', confidence: 0.95 },
      { name: 'statementMonth', value: THIS_MONTH, confidence: 0.97 },
      { name: 'statementEnd', value: iso(2), confidence: 0.97 },
      { name: 'pagesPresent', value: 5, confidence: 0.95 }, { name: 'pagesTotal', value: 5, confidence: 0.95 },
      { name: 'endingBalance', value: '$44,981.10', confidence: 0.96 },
    ],
  },
  CREDIT: {
    docKey: 'credit_report', docKeyConfidence: 0.99,
    fields: [
      { name: 'reportDate', value: iso(10), confidence: 0.98 },
      { name: 'documentDate', value: iso(10), confidence: 0.98 },
      { name: 'borrowerName', value: 'Daria N', confidence: 0.97 },
      { name: 'equifaxScore', value: 612, confidence: 0.99 },
      { name: 'experianScore', value: 640, confidence: 0.99 },
      { name: 'transUnionScore', value: 655, confidence: 0.99 },
    ],
    tradelines: [
      { creditorName: 'Chase Card', accountType: 'revolving', monthlyPayment: 185, balance: 4210, status: 'open', confidence: 0.96 },
      { creditorName: 'Discover', accountType: 'revolving', monthlyPayment: 340, balance: 6100, status: 'open', confidence: 0.95 },
      { creditorName: 'Dept of Education', accountType: 'installment student loan', monthlyPayment: 0, balance: 24000, status: 'deferred', confidence: 0.94 },
      { creditorName: 'Old Navy', accountType: 'revolving', monthlyPayment: 0, balance: 0, status: 'closed', confidence: 0.95 },
    ],
  },
  IDFRONT: {
    docKey: 'id_photo', docKeyConfidence: 0.98,
    fields: [
      { name: 'fullName', value: 'Daria N', confidence: 0.96 },
      { name: 'side', value: 'front', confidence: 0.97 },
      { name: 'expirationDate', value: '2031-05-01', confidence: 0.97 },
    ],
  },
  PSA: {
    docKey: 'purchase_contract', docKeyConfidence: 0.98,
    fields: [
      { name: 'purchasePrice', value: '$620,000', confidence: 0.97 },
      { name: 'buyerNames', value: 'Daria N', confidence: 0.95 },
      { name: 'signedByAllParties', value: true, confidence: 0.94 },
      { name: 'pagesPresent', value: 12, confidence: 0.95 }, { name: 'pagesTotal', value: 12, confidence: 0.95 },
    ],
  },
}

function routedModel() {
  const calls = []
  return Object.assign(async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const b64 = body.messages[0].content[0].source.data
    const tag = Buffer.from(b64, 'base64').toString('utf8').replace(/[^A-Z0-9]/g, '')
    const reading = READINGS[tag]
    if (!reading) throw new Error(`model stub got an unexpected document: ${tag}`)
    return {
      ok: true, status: 200,
      json: async () => ({
        stop_reason: 'end_turn', model: 'claude-opus-5',
        usage: { input_tokens: 1200, output_tokens: 200 },
        content: [{ type: 'text', text: JSON.stringify(reading) }],
      }),
    }
  }, { calls })
}

function buildWorld() {
  const fake = createFakeSupabase({
    users: USERS,
    tables: {
      loan_files: [{
        id: LOAN, owner_user_id: OWNER, organization_id: 'org-1',
        borrower_name: 'Daria N', stage: 'application', purpose: 'purchase',
      }],
      portal_access: [{ portal_user: BORROWER, loan_file_id: LOAN, visibility: 'borrower' }],
      portal_team: [], portal_access_log: [],
      loan_documents: Object.values(DOCS).map((d) => ({
        id: d.id, loan_file_id: LOAN, owner_user_id: OWNER, doc_key: d.doc_key,
        label: d.doc_key, status: 'uploaded', storage_path: d.path, who: 'borrower',
      })),
      document_extractions: [], pre_underwriting_findings: [], credit_authorizations: [],
      mortgage_applications: [], application_parties: [], application_field_events: [],
      application_field_state: [], application_turns: [], application_secure_fields: [],
      application_attestations: [],
    },
  })
  for (const d of Object.values(DOCS)) {
    fake.putFile(d.path, Buffer.from(d.tag), d.path.endsWith('.png') ? 'image/png' : 'application/pdf')
  }
  return fake
}

let bust = 0
async function handlers() {
  setTestEnv({
    PRE_UNDERWRITING_ENABLED: 'true',
    CONVERSATIONAL_1003_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'test-key-not-real',
  })
  bust++
  const q = `?journey=${bust}`
  return {
    intake: (await import(`../netlify/functions/pre-underwriting-intake.mjs${q}`)).default,
    review: (await import(`../netlify/functions/pre-underwriting-review.mjs${q}`)).default,
    credit: (await import(`../netlify/functions/credit-authorization.mjs${q}`)).default,
    session: (await import(`../netlify/functions/application-session.mjs${q}`)).default,
    team1003: (await import(`../netlify/functions/application-team-review.mjs${q}`)).default,
  }
}

function install(fake, model) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) return model(url, opts)
    return fake.fetch(url, opts)
  }
  return () => { globalThis.fetch = original }
}

const key = (s) => `j.${String(s).replace(/[^A-Za-z0-9_.:-]/g, '-')}.${Math.random().toString(36).slice(2, 10)}`
const POST = (body, token = 'tok-owner') => makeRequest('https://a/x', { method: 'POST', token, body })
const GETP = () => makeRequest(`https://a/x?loanFileId=${LOAN}`, { token: 'tok-owner' })
const okJson = async (res, label) => {
  const body = await res.json()
  assert.equal(res.status, 200, `${label}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

test('the whole journey: 1003 → documents → numbers → import → human → re-run', async () => {
  const fake = buildWorld()
  const model = routedModel()
  const restore = install(fake, model)
  try {
    const h = await handlers()

    // ── Act 1: what Daria put on her application ───────────────────────────
    // Written through the real team endpoint so it takes the real reducer/projection path.
    const say = (fieldPath, value) => h.team1003(POST({
      loanFileId: LOAN, action: 'correct', fieldPath, value, idempotencyKey: key(fieldPath),
    }))
    for (const [path, value] of [
      ['parties[0].hasAnyLiabilities', 'yes'],
      ['parties[0].liabilities[0].liabilityType', 'revolving'],
      ['parties[0].liabilities[0].creditorName', 'Chase Card'],
      ['parties[0].liabilities[0].monthlyPayment', '185'],
      ['parties[0].liabilities[0].unpaidBalance', '4210'],
      ['parties[0].liabilities[0].toBePaidOffAtClosing', 'no'],
      ['loan.requestedLoanAmount', '496000'],
    ]) await okJson(await say(path, value), `1003 ${path}`)

    // ── Act 2: Daria authorizes the credit pull; the loan officer cannot ───
    const loTries = await h.credit(POST({
      loanFileId: LOAN, accepted: true, documentVersion: CREDIT_AUTH_VERSION,
      presentedAt: new Date().toISOString(), idempotencyKey: key('lo-auth'),
    }, 'tok-owner'))
    assert.equal(loTries.status, 403, 'the file owner must not be able to authorize')
    await okJson(await h.credit(POST({
      loanFileId: LOAN, accepted: true, documentVersion: CREDIT_AUTH_VERSION,
      presentedAt: new Date(Date.now() - 8000).toISOString(), idempotencyKey: key('auth'),
    }, 'tok-borrower')), 'borrower authorizes')

    // ── Act 3: every document is read ──────────────────────────────────────
    for (const d of Object.values(DOCS)) {
      const r = await okJson(await h.intake(POST({
        loanFileId: LOAN, documentId: d.id, idempotencyKey: key(`read-${d.tag}`),
      })), `read ${d.tag}`)
      assert.equal(r.extraction.docKey, d.doc_key, `${d.tag} classified`)
      assert.equal(r.extraction.docKeyMismatch, false, `${d.tag} not a mismatch`)
    }

    // ── Act 4: the panel, checked by hand ──────────────────────────────────
    const panel = await okJson(await h.review(GETP()), 'panel')

    // The checklist followed the loan: a purchase asks for a contract, not a mortgage statement.
    assert.equal(panel.credit.authorized, true)
    assert.deepEqual(panel.unread, [], 'everything uploaded has been read')

    const f = panel.facts
    assert.equal(f.creditScore.score, 640, 'middle of 612/640/655 — not the average 635.67')
    assert.equal(f.income.monthly, 8400, 'semi-monthly $4,200 × 24 / 12')
    assert.equal(f.income.basis, 'pay stub')
    // Chase 185 + Discover 340; the deferred student loan's $0 is a GAP, not a zero.
    assert.equal(f.debt.monthly, 525)
    assert.equal(f.debt.unknownPayments, 2, 'Dept of Education and closed Old Navy have no usable payment')
    assert.equal(f.dti.percent, 6.25, '525 / 8400, debts only')
    assert.match(f.dti.kind, /no proposed housing/)
    assert.equal(f.ltv.percent, 80, '496,000 / 620,000 from the signed contract')

    // 640 rules conventional (620) IN; jumbo (700) and usda (640 min — 640 passes) …assert the
    // two that matter: FHA suitable, jumbo out for score AND conforming amount.
    assert.ok(panel.programs.suitable.some((p) => p.key === 'fha'))
    assert.ok(panel.programs.suitable.some((p) => p.key === 'conventional'))
    assert.ok(panel.programs.notSuitable.some((p) => p.key === 'jumbo'))

    // The ID is half-uploaded (front only) — the borrower list must say so and say ONLY that.
    const idAsk = panel.missing.borrower.find((m) => m.docKey === 'id_photo')
    assert.ok(idAsk, 'front-only ID is not complete')
    assert.match(idAsk.asks.join(' '), /back/i)
    const w2Ask = panel.missing.borrower.find((m) => m.docKey === 'w2_2yr')
    assert.ok(w2Ask, 'one W-2 year of two')
    assert.ok(!panel.missing.borrower.some((m) => m.docKey === 'credit_report'),
      'the borrower is never asked for the credit report')

    // Findings: Discover is undisclosed. Chase is NOT (declared). No false income finding —
    // the stub and W-2 agree at exactly $8,400/mo.
    const open = panel.findings.filter((x) => x.status === 'pending_review')
    const undisclosed = open.filter((x) => x.rule === 'undisclosed_liability')
    assert.equal(undisclosed.length, 1, JSON.stringify(open.map((x) => [x.rule, x.explanation])))
    assert.match(undisclosed[0].explanation, /Discover/)
    assert.ok(!open.some((x) => x.rule === 'income_consistency'),
      'agreeing income sources must not produce a finding')

    // The reconciliation the button will act on, shown before it is pressed.
    assert.equal(panel.liabilitySync.matched, 1, 'Chase matched against the declared card')
    const importNames = panel.liabilitySync.toImport.map((t) => t.creditorName).sort()
    assert.deepEqual(importNames, ['Dept of Education', 'Discover'])
    assert.ok(panel.liabilitySync.toImport.find((t) => t.creditorName === 'Dept of Education').needsPayment,
      'a deferred $0 payment is flagged, not treated as free')
    assert.deepEqual(panel.liabilitySync.skipped.map((s) => s.creditorName), ['Old Navy'],
      'a closed zero-balance account is not a liability')

    // ── Act 5: the import writes into the 1003 — as data, never as Daria ──
    const imported = await okJson(await h.review(POST({
      loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('import'),
    })), 'import')
    assert.equal(imported.result.imported.length, 2)

    const events = fake.rowsOf('application_field_events')
      .filter((e) => e.source === 'imported_credit')
    assert.ok(events.length >= 6, 'type/creditor/payment/balance per imported row')
    // Indexes continue after Daria's own row — hers is untouched.
    assert.ok(events.every((e) => !e.field_path.startsWith('parties[0].liabilities[0].')),
      'the declared Chase row is never overwritten by an import')
    const idx = [...new Set(events.map((e) => /liabilities\[(\d+)\]/.exec(e.field_path)?.[1]))].sort()
    assert.deepEqual(idx, ['1', '2'], 'imports fill the next free slots')

    // Projection: the imported values sit as candidates for Daria to confirm — importing fills
    // the form in, it does not answer for her.
    const stateRows = fake.rowsOf('application_field_state')
      .filter((s) => s.source === 'imported_credit')
    assert.ok(stateRows.length >= 6)
    assert.ok(stateRows.every((s) => s.status === 'candidate'), JSON.stringify([...new Set(stateRows.map((s) => s.status))]))

    // The finding resolved itself the honest way: the fact changed, so the rule stopped firing.
    const after = imported
    assert.ok(!after.findings.some((x) => x.rule === 'undisclosed_liability' && x.status === 'pending_review'),
      'undisclosed_liability must clear once the liability is on the application')
    assert.equal(after.liabilitySync.toImport.length, 0, 'nothing left to import')
    assert.equal(after.liabilitySync.matched, 3, 'Chase + Discover + Dept of Education all reconciled')
    // Debt on the panel is still credit-report-driven and unchanged by the import.
    assert.equal(after.facts.debt.monthly, 525)

    // ── Act 6: pressing the button twice must not duplicate anybody's debt ─
    const again = await h.review(POST({
      loanFileId: LOAN, action: 'import_liabilities', idempotencyKey: key('import2'),
    }))
    if (again.status === 200) {
      assert.equal((await again.json()).result.imported.length, 0, 'a second import writes nothing')
    } // a 409 "nothing to import" is equally correct
    const eventsAfterTwice = fake.rowsOf('application_field_events').filter((e) => e.source === 'imported_credit')
    assert.equal(eventsAfterTwice.length, events.length, 'no duplicate rows from a double click')

    // ── Act 7: a human decision, then a re-run, and the decision survives ──
    const lowConf = after.findings.find((x) => x.rule === 'low_confidence_extraction' && x.status === 'pending_review')
    if (lowConf) {
      await okJson(await h.review(POST({
        loanFileId: LOAN, findingId: lowConf.id, action: 'dismiss',
        note: 'checked against the original', idempotencyKey: key('dismiss'),
      })), 'dismiss')
    }
    await okJson(await h.intake(POST({
      loanFileId: LOAN, documentId: DOCS.bankJul.id, idempotencyKey: key('reread'),
    })), 're-read a statement')
    const final = await okJson(await h.review(GETP()), 'final panel')
    assert.ok(!final.findings.some((x) => x.rule === 'undisclosed_liability' && x.status === 'pending_review'),
      'the import must survive a later document read — the fix does not un-fix itself')
    if (lowConf) {
      const still = final.findings.find((x) => x.id === lowConf.id)
      assert.equal(still?.status, 'dismissed', 'a dismissal outlives a re-run')
    }

    // ── Act 8: Daria's own view ────────────────────────────────────────────
    const session = await okJson(await h.session(
      makeRequest(`https://a/x?loanFileId=${LOAN}`, { token: 'tok-borrower' }),
    ), 'borrower session')
    assert.equal(session.canAttest, false, 'imported candidates are unconfirmed; she cannot attest yet')
    const serialized = JSON.stringify(session)
    // What must NEVER reach her from this system: the score, the findings, the readiness figure.
    for (const never of ['640', '612', '655', 'undisclosed', 'readiness', 'finding']) {
      assert.ok(!serialized.includes(never), `the borrower must never see "${never}" from this system`)
    }
    // What MUST reach her: the imported liability, as her own application data awaiting her
    // confirmation. Importing fills the form in; she still owns the answer. If this stopped
    // appearing, the import would be answering the 1003 behind her back.
    assert.ok(serialized.includes('Discover'),
      'the imported liability must appear in her own application for confirmation')
    const importedState = fake.rowsOf('application_field_state')
      .filter((r) => r.source === 'imported_credit' && /creditorName/.test(r.field_path))
    assert.ok(importedState.every((r) => r.status === 'candidate'),
      'imported rows await her confirmation — never auto-confirmed')
  } finally { restore() }
})
