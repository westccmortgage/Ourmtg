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
import { makeRequest, setTestEnv } from './_fakeSupabase.mjs'
import { CREDIT_AUTH_VERSION } from '../src/features/pre-underwriting/creditAuthorization.js'
import { LOAN, BORROWER, DOCS, routedModel, buildWorld } from './_journeyWorld.mjs'


let bust = 0
async function handlers() {
  setTestEnv({
    PRE_UNDERWRITING_ENABLED: 'true',
    CONVERSATIONAL_1003_ENABLED: 'true',
    ANTHROPIC_API_KEY: 'test-key-not-real',
    OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock', OURMTG_ALLOW_MOCK_SCAN: 'true',
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
