// The "Daria buys a house" world — one realistic file, shared by the journey test and the
// in-browser UI run so the two can never drift apart. Exports the fake database, the routed
// model stub, and the ids the scenario is written in terms of.
import { createFakeSupabase } from './_fakeSupabase.mjs'

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
    const raw = Buffer.from(b64, 'base64').toString('utf8')
    const tag = Object.keys(READINGS).find((candidate) => raw.includes(candidate))
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
    const bytes = d.path.endsWith('.png')
      ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(d.tag)])
      : Buffer.from(`%PDF-1.4\n${d.tag}`)
    fake.putFile(d.path, bytes, d.path.endsWith('.png') ? 'image/png' : 'application/pdf')
  }
  return fake
}

export { LOAN, OWNER, BORROWER, USERS, DOCS, READINGS, routedModel, buildWorld, LAST_MONTH, THIS_MONTH, iso }
