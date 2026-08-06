// The borrower's checklist and the pre-underwriting panel must tell ONE story about the same
// file. These pin the two screen-visible bugs the in-browser run caught:
//
//   1. The credit report — a document only the loan team can obtain — was listed on the
//      borrower's own checklist as "credit_report · REPLACE", a raw key and an impossible ask.
//   2. "All documents are in — nice work!" while the panel knew the ID had one side and the
//      W-2 covered one year of two. "Uploaded" was counted as "done" with no completeness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRequest, setTestEnv } from './_fakeSupabase.mjs'
import { LOAN, DOCS, routedModel, buildWorld } from './_journeyWorld.mjs'

let bust = 0
async function load() {
  setTestEnv({
    PRE_UNDERWRITING_ENABLED: 'true', CONVERSATIONAL_1003_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'test-key-not-real',
  })
  bust++
  return {
    checklist: (await import(`../netlify/functions/portal-checklist.mjs?c=${bust}`)).default,
    intake: (await import(`../netlify/functions/pre-underwriting-intake.mjs?c=${bust}`)).default,
  }
}
const install = (fake, model) => {
  const orig = globalThis.fetch
  globalThis.fetch = async (u, o) => (String(u).includes('api.anthropic.com') ? model(u, o) : fake.fetch(u, o))
  return () => { globalThis.fetch = orig }
}
const key = (s) => `pc.${s}.${Math.random().toString(36).slice(2, 10)}`
const get = (h, token) => h(makeRequest(`https://a/x?loanFileId=${LOAN}`, { token }))

test('the borrower checklist and the panel tell one story', async () => {
  const fake = buildWorld()
  const model = routedModel()
  const restore = install(fake, model)
  try {
    const h = await load()
    for (const d of Object.values(DOCS)) {
      const r = await h.intake(makeRequest('https://a/x', {
        method: 'POST', token: 'tok-owner',
        body: { loanFileId: LOAN, documentId: d.id, idempotencyKey: key(d.tag) },
      }))
      assert.equal(r.status, 200, d.tag)
    }

    // ── borrower view ──────────────────────────────────────────────────────
    const b = await (await get(h.checklist, 'tok-borrower')).json()
    assert.equal(b.ok, true)

    // 1. No team-only documents, and no raw keys anywhere on her screen.
    assert.ok(!b.items.some((i) => i.docKey === 'credit_report'),
      'the credit report is the team\'s to obtain and must not appear on the borrower list')
    assert.ok(b.items.every((i) => i.label && i.label !== i.docKey), 'labels, never raw keys')

    // 2. Uploaded-but-incomplete is NOT done, and each one says exactly what to send.
    const id = b.items.find((i) => i.docKey === 'id_photo')
    assert.equal(id.complete, false)
    assert.match(id.gaps.join(' '), /back/i)
    const w2 = b.items.find((i) => i.docKey === 'w2_2yr')
    assert.equal(w2.complete, false)
    assert.match(w2.gaps.join(' '), /1 of 2 years/)
    assert.ok(b.remaining >= 2, `"all in" must not be claimable: ${JSON.stringify({ uploaded: b.uploaded, total: b.total })}`)

    // Nothing on her list is a conclusion about her — requests only.
    const everything = JSON.stringify(b)
    for (const leak of ['640', 'undisclosed', 'readiness', 'Discover', 'tri-merge']) {
      assert.ok(!everything.includes(leak), `borrower checklist leaked "${leak}"`)
    }

    // ── owner view keeps the whole picture ─────────────────────────────────
    const o = await (await get(h.checklist, 'tok-owner')).json()
    const credit = o.items.find((i) => i.docKey === 'credit_report')
    assert.ok(credit, 'the team still sees the credit report on the file')
    assert.equal(credit.label, 'Credit report (tri-merge)', 'and by its name, not its key')
  } finally { restore() }
})

test('a complete file is still allowed to be complete', async () => {
  // The fix must not make "done" unreachable: with both ID sides and both W-2 years read, the
  // items count as done and nothing nags.
  const fake = buildWorld()
  const model = routedModel()
  const restore = install(fake, model)
  try {
    const h = await load()
    for (const d of Object.values(DOCS)) {
      await h.intake(makeRequest('https://a/x', {
        method: 'POST', token: 'tok-owner',
        body: { loanFileId: LOAN, documentId: d.id, idempotencyKey: key(d.tag) },
      }))
    }
    // Second reads arrive: the back of the ID and the second W-2 year.
    fake.rowsOf('document_extractions').push(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', loan_file_id: LOAN,
        document_id: DOCS.id.id, doc_key: 'id_photo',
        fields: { fields: [{ name: 'side', value: 'back', confidence: 0.97 }, { name: 'expirationDate', value: '2031-05-01', confidence: 0.97 }], tradelines: [] },
        superseded_by: null, created_at: new Date().toISOString(),
      },
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', loan_file_id: LOAN,
        document_id: DOCS.w2.id, doc_key: 'w2_2yr',
        fields: { fields: [{ name: 'taxYear', value: 2024, confidence: 0.97 }, { name: 'wagesTipsOther', value: 98000, confidence: 0.97 }], tradelines: [] },
        superseded_by: null, created_at: new Date().toISOString(),
      },
    )
    const b = await (await get(h.checklist, 'tok-borrower')).json()
    assert.equal(b.items.find((i) => i.docKey === 'id_photo').complete, true)
    assert.equal(b.items.find((i) => i.docKey === 'w2_2yr').complete, true)
  } finally { restore() }
})
