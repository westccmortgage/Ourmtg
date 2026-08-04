// The layers meeting. Everything below is the seam between what Level 2 read, what Level 3
// concludes, and what a person is shown — the places where an architecture that reads well in
// four separate files goes wrong when it is finally connected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalysisContext, newestPerDocument } from './analysisContext.js'
import { preUnderwritingChecklist } from '../../../netlify/functions/_lib/checklist.mjs'
import { validateExtractionResponse } from './extractionContract.js'
import { runRules } from './rules.js'
import { loanReadiness, borrowerRequests } from './readiness.js'
import { programFit, CONFORMING_LIMIT } from './programFit.js'
import {
  representativeScore, fileScore, qualifyingIncome, monthlyDebt, debtToIncome, loanToValue,
  qualifyingFacts,
} from './qualifyingFacts.js'
import { getDocumentType } from './documentCatalog.js'
import {
  creditPullAllowed, validateAcceptance, authorizationGap,
  CREDIT_AUTH_VERSION, CREDIT_AUTHORIZATION, AUTHORIZATION_VALID_DAYS,
} from './creditAuthorization.js'

const AS_OF = Date.parse('2026-08-01T00:00:00Z')
const DAY = 86_400_000

const read = (docKey, fields, extra = {}) => ({
  ...validateExtractionResponse({
    docKey, docKeyConfidence: 0.98,
    fields: Object.entries(fields).map(([name, v]) => ({
      name, value: Array.isArray(v) ? v[0] : v, confidence: Array.isArray(v) ? v[1] : 0.97,
    })),
    ...(extra.tradelines ? { tradelines: extra.tradelines } : {}),
  }).value,
  documentId: extra.documentId || `doc-${docKey}`,
  createdAt: extra.createdAt || '2026-07-30T00:00:00Z',
  supersededBy: extra.supersededBy || null,
})

// ── which read counts ───────────────────────────────────────────────────────

test('re-reading one document does not make the file look like it has two', () => {
  // The failure this prevents: a better scan arrives, and name_consistency fires because the
  // borrower "appears in two forms" — both of them from the same piece of paper.
  const first = read('bank_2mo', { accountHolder: 'Dara N' }, { documentId: 'd1', createdAt: '2026-07-01T00:00:00Z' })
  const better = read('bank_2mo', { accountHolder: 'Daria N' }, { documentId: 'd1', createdAt: '2026-07-20T00:00:00Z' })

  const live = newestPerDocument([first, better])
  assert.equal(live.length, 1)
  assert.equal(live[0].fields.find((f) => f.name === 'accountHolder').value, 'Daria N')
})

test('a superseded read is history, not evidence', () => {
  const old = read('bank_2mo', { endingBalance: 100 }, { documentId: 'd1', supersededBy: 'x' })
  assert.deepEqual(newestPerDocument([old]), [])
})

test('two genuinely different documents both count', () => {
  const a = read('bank_2mo', { endingBalance: 100 }, { documentId: 'd1' })
  const b = read('bank_2mo', { endingBalance: 200 }, { documentId: 'd2' })
  assert.equal(newestPerDocument([a, b]).length, 2)
})

// ── the context the rules actually read ─────────────────────────────────────

test('extractions become documents, evidence, and credit liabilities in one pass', () => {
  const ctx = buildAnalysisContext({
    asOf: AS_OF,
    extractions: [
      read('paystubs_30d', { grossPay: 4000, payPeriodStart: '2026-07-01', payPeriodEnd: '2026-07-15', payFrequency: 'semimonthly' }),
      read('credit_report', { equifaxScore: 728 }, {
        tradelines: [{ creditorName: 'Discover', monthlyPayment: 320, confidence: 0.95 }],
      }),
    ],
    application: { monthlyIncome: 8000 },
  })

  assert.ok(ctx.documents.paystubs_30d)
  assert.equal(ctx.documents.paystubs_30d[0].grossPay, 4000)
  assert.ok(ctx.extractions.some((e) => e.field === 'equifaxScore' && e.confidence === 0.97))
  assert.equal(ctx.creditLiabilities.length, 1)
  assert.equal(ctx.creditLiabilities[0].creditorName, 'Discover')
  assert.equal(ctx.application.monthlyIncome, 8000)
})

test('the borrower is authoritative about their own start date, not a pay stub', () => {
  // Backwards, this makes incomeConsistency fire on every borrower whose stub is recent.
  const withStated = buildAnalysisContext({
    extractions: [read('paystubs_30d', { employmentStartDate: '2026-05-01' })],
    application: { employmentStartDate: '2019-03-01' },
  })
  assert.equal(withStated.employment.startDate, '2019-03-01')
  assert.equal(withStated.employment.source, 'application')
})

test('an empty file produces an empty context, not a crash', () => {
  const ctx = buildAnalysisContext({})
  assert.deepEqual(ctx.documents, {})
  assert.deepEqual(ctx.extractions, [])
  assert.deepEqual(ctx.deposits, [])
  assert.deepEqual(runRules(ctx), { findings: [], errors: [] })
})

test('an unclassified read contributes nothing but does not break the pass', () => {
  const junk = { ...validateExtractionResponse({ docKey: null, docKeyConfidence: 0.2, fields: [] }).value, documentId: 'd9' }
  const ctx = buildAnalysisContext({ extractions: [junk] })
  assert.deepEqual(ctx.documents, {})
  assert.deepEqual(ctx.extractions, [])
})

test('the whole chain runs: read → context → rule → finding with evidence', () => {
  const ctx = buildAnalysisContext({
    asOf: AS_OF,
    extractions: [read('credit_report', { equifaxScore: 728 }, {
      tradelines: [{ creditorName: 'Discover', monthlyPayment: 320, confidence: 0.95 }],
    })],
    application: { liabilities: [{ creditorName: 'Chase' }] },
  })
  const { findings, errors } = runRules(ctx)
  assert.deepEqual(errors, [])
  const undisclosed = findings.find((f) => f.rule === 'undisclosed_liability')
  assert.ok(undisclosed, JSON.stringify(findings.map((f) => f.rule)))
  assert.match(undisclosed.explanation, /Discover/)
  assert.ok(undisclosed.evidence.some((e) => e.docKey === 'credit_report'))
})

// ── the checklist ───────────────────────────────────────────────────────────

test('the panel checklist is the borrower checklist plus what only the team can get', () => {
  // One checklist, two views — a second checklist in the analysis code meant the panel could say
  // "missing X" while the borrower's portal said "missing Y" about the same file.
  const purchase = preUnderwritingChecklist({ loanType: 'Conventional', purpose: 'purchase' }).map((c) => c.docKey)
  assert.ok(purchase.includes('purchase_contract'))
  assert.ok(purchase.includes('paystubs_30d'))
  assert.ok(!purchase.includes('mortgage_statement'))

  const refi = preUnderwritingChecklist({ loanType: 'Conventional', purpose: 'refinance' }).map((c) => c.docKey)
  assert.ok(refi.includes('mortgage_statement'))
  assert.ok(refi.includes('hoi_dec'))
  assert.ok(!refi.includes('purchase_contract'))

  // Bank-statement programs drop the wage-earner documents rather than stall the file on them.
  const nonQm = preUnderwritingChecklist({ loanType: 'Non-QM', purpose: 'purchase' }).map((c) => c.docKey)
  assert.ok(nonQm.includes('bank_12mo') && nonQm.includes('business_lic'))
  assert.ok(!nonQm.includes('paystubs_30d'))

  const va = preUnderwritingChecklist({ loanType: 'VA', purpose: 'purchase' }).map((c) => c.docKey)
  assert.ok(va.includes('coe') && va.includes('dd214'))
})

test('every loan needs identity and credit, and no key repeats, and every key is in the catalog', () => {
  for (const loan of [{}, { loanType: 'VA', purpose: 'purchase' }, { loanType: 'DSCR', purpose: 'refinance' }, { loanType: 'Jumbo', purpose: 'purchase' }]) {
    const keys = preUnderwritingChecklist(loan).map((c) => c.docKey)
    assert.ok(keys.includes('id_photo'), JSON.stringify(loan))
    assert.ok(keys.includes('credit_report'), JSON.stringify(loan))
    assert.equal(keys.length, new Set(keys).size, 'a repeated key would double-count in readiness')
    // A checklist key the document catalog cannot assess silently never completes.
    for (const k of keys) assert.ok(getDocumentType(k), `${k} is not in the document catalog`)
  }
})

// ── readiness ───────────────────────────────────────────────────────────────

const CHECKLIST = [{ docKey: 'id_photo' }, { docKey: 'paystubs_30d' }, { docKey: 'credit_report' }]
const COMPLETE_DOCS = {
  id_photo: [{ side: 'front', expirationDate: '2030-01-01' }, { side: 'back', expirationDate: '2030-01-01' }],
  paystubs_30d: [{ payPeriodStart: '2026-07-01', payPeriodEnd: '2026-07-31' }],
  credit_report: [{ reportDate: '2026-07-15', documentDate: '2026-07-15', equifaxScore: 720, experianScore: 730, transUnionScore: 725 }],
}

test('readiness says what it measures, and states what it does not mean', () => {
  const r = loanReadiness({ checklist: CHECKLIST, byType: COMPLETE_DOCS, findings: [], asOf: AS_OF })
  assert.equal(r.components.documents.percent, 100)
  assert.ok(r.percent > 90)
  // The number is the dangerous part of this product; the disclaimer travels with it.
  for (const phrase of ['approval', 'probability', 'credit decision']) {
    assert.ok(r.notMeaning.some((n) => n.includes(phrase)), phrase)
  }
})

test('a resolved finding stops costing the file', () => {
  // Otherwise the score never recovers from work that was actually done.
  const open = loanReadiness({
    checklist: CHECKLIST, byType: COMPLETE_DOCS, asOf: AS_OF,
    findings: [{ rule: 'r', severity: 'high', status: 'pending_review' }],
  })
  const closed = loanReadiness({
    checklist: CHECKLIST, byType: COMPLETE_DOCS, asOf: AS_OF,
    findings: [{ rule: 'r', severity: 'high', status: 'dismissed' }],
  })
  assert.ok(closed.percent > open.percent)
  assert.equal(closed.components.questions.open, 0)
})

test('blockers name who has to act, so nobody chases the borrower for a credit report', () => {
  const r = loanReadiness({ checklist: CHECKLIST, byType: {}, findings: [], asOf: AS_OF })
  const credit = r.blockers.find((b) => b.docKey === 'credit_report')
  const stubs = r.blockers.find((b) => b.docKey === 'paystubs_30d')
  assert.equal(credit.owner, 'loan_team')
  assert.equal(stubs.owner, 'borrower')
})

test('high-severity findings sort above low ones, after the documents', () => {
  const r = loanReadiness({
    checklist: CHECKLIST, byType: COMPLETE_DOCS, asOf: AS_OF,
    findings: [
      { rule: 'a', severity: 'low', status: 'pending_review', explanation: 'minor' },
      { rule: 'b', severity: 'high', status: 'pending_review', explanation: 'serious' },
    ],
  })
  const kinds = r.blockers.map((b) => b.severity).filter(Boolean)
  assert.deepEqual(kinds, ['high', 'low'])
})

test('the borrower is asked only for what they can send, as requests', () => {
  const asks = borrowerRequests(CHECKLIST, {}, { asOf: AS_OF })
  assert.deepEqual(asks.map((a) => a.docKey), ['id_photo', 'paystubs_30d'])
  // And nothing in what they see is a conclusion about them.
  const forbidden = /\b(denied|declined|approved|qualif|ineligible|risk|score|dti|ltv)\b/i
  for (const a of asks) for (const line of a.asks) assert.doesNotMatch(line, forbidden, line)
})

test('an empty file is zero, not a perfect score', () => {
  const r = loanReadiness({ checklist: CHECKLIST, byType: {}, findings: [], asOf: AS_OF })
  assert.equal(r.components.documents.percent, 0)
  assert.ok(r.percent < 40)
})

// ── program fit ─────────────────────────────────────────────────────────────

test('a program is never ruled out on a number nobody has', () => {
  // The failure: an empty file "does not qualify" for everything, and a processor believes it.
  const empty = programFit({})
  assert.equal(empty.notSuitable.length, 0)
  assert.equal(empty.suitable.length > 0, true)
  assert.ok(empty.unknowns.includes('credit score'))
  for (const p of empty.suitable) assert.ok(p.assumptions.length > 0, p.key)
})

test('a program ruled out says which published number it was measured against', () => {
  const fit = programFit({ creditScore: 600, ltv: 80, dti: 40 })
  const conv = fit.notSuitable.find((p) => p.key === 'conventional')
  assert.ok(conv)
  assert.match(conv.reasons[0], /600 is below 620/)
  assert.match(conv.guideline, /score ≥ 620/)
  // FHA tolerates the same borrower, which is the entire point of showing more than one.
  assert.ok(fit.suitable.some((p) => p.key === 'fha'))
})

test('an unanswered military-service question is not a "no"', () => {
  // Treating it as one silently removes the best program a veteran can get.
  assert.ok(programFit({ creditScore: 700, ltv: 100, dti: 40 }).suitable.some((p) => p.key === 'va'))
  assert.ok(programFit({ creditScore: 700, ltv: 100, dti: 40, veteran: false }).notSuitable.some((p) => p.key === 'va'))
})

test('jumbo is not suggested below the conforming limit', () => {
  const fit = programFit({ creditScore: 780, ltv: 70, dti: 35, loanAmount: CONFORMING_LIMIT - 1 })
  assert.ok(fit.notSuitable.some((p) => p.key === 'jumbo'))
  const above = programFit({ creditScore: 780, ltv: 70, dti: 35, loanAmount: CONFORMING_LIMIT + 1 })
  assert.ok(above.suitable.some((p) => p.key === 'jumbo'))
})

test('what was not examined is stated, every time', () => {
  // The difference between a screening tool and something read as an underwriting decision.
  const fit = programFit({ creditScore: 760, ltv: 60, dti: 30 })
  for (const phrase of ['automated underwriting', 'overlays', 'appraisal']) {
    assert.ok(fit.notChecked.some((n) => n.includes(phrase)), phrase)
  }
})

// ── credit authorization ────────────────────────────────────────────────────

const accepted = (daysAgo, over = {}) => ({
  partyIndex: 0,
  acceptedAt: new Date(AS_OF - daysAgo * DAY).toISOString(),
  documentVersion: CREDIT_AUTH_VERSION,
  ...over,
})

test('no authorization means no pull', () => {
  const r = creditPullAllowed([], { asOf: AS_OF })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not_authorized')
})

test('a fresh authorization allows the pull and says when it lapses', () => {
  const r = creditPullAllowed([accepted(3)], { asOf: AS_OF })
  assert.equal(r.ok, true)
  assert.equal(r.expiresAt, AS_OF - 3 * DAY + AUTHORIZATION_VALID_DAYS * DAY)
})

test('permission expires; it is a re-ask, not a failure', () => {
  const r = creditPullAllowed([accepted(AUTHORIZATION_VALID_DAYS + 1)], { asOf: AS_OF })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'expired')
  assert.match(authorizationGap({ authorizations: [accepted(200)], asOf: AS_OF }).explanation, /authorize again/)
})

test('re-authorizing after an expiry works, and revoking undoes it', () => {
  assert.equal(creditPullAllowed([accepted(200), accepted(1)], { asOf: AS_OF }).ok, true)
  assert.equal(creditPullAllowed([accepted(1, { revokedAt: '2026-07-31T00:00:00Z' })], { asOf: AS_OF }).ok, false)
})

test('the co-borrower authorizes for themselves', () => {
  // One person's permission is not the other's, and pulling on it would be a pull without one.
  const auths = [accepted(1, { partyIndex: 0 })]
  assert.equal(creditPullAllowed(auths, { asOf: AS_OF, partyIndex: 0 }).ok, true)
  assert.equal(creditPullAllowed(auths, { asOf: AS_OF, partyIndex: 1 }).ok, false)
})

test('acceptance is refused unless the client echoes the wording it displayed', () => {
  const base = { accepted: true, documentVersion: CREDIT_AUTH_VERSION, presentedAt: new Date(AS_OF - 5000).toISOString(), partyIndex: 0 }
  assert.equal(validateAcceptance(base, { asOf: AS_OF }).ok, true)
  // The page was open across a wording change; accepting records consent to text nobody saw.
  assert.equal(validateAcceptance({ ...base, documentVersion: '2020.old' }, { asOf: AS_OF }).error, 'stale_version')
  assert.equal(validateAcceptance({ ...base, accepted: false }, { asOf: AS_OF }).error, 'not_accepted')
  assert.equal(validateAcceptance({ ...base, presentedAt: 'nonsense' }, { asOf: AS_OF }).error, 'invalid_presented_at')
  // A presentation timestamp in the future is a clock problem or a forged one; neither is proof.
  assert.equal(validateAcceptance({ ...base, presentedAt: new Date(AS_OF + DAY).toISOString() }, { asOf: AS_OF }).error, 'invalid_presented_at')
  assert.equal(validateAcceptance({ ...base, partyIndex: 7 }, { asOf: AS_OF }).error, 'invalid_party')
})

test('the wording tells the borrower the three things they would otherwise ask', () => {
  const en = CREDIT_AUTHORIZATION.body.en.join(' ')
  assert.match(en, /hard inquiry/i)            // will this hurt my score
  assert.match(en, /45-day/)                   // can I shop around
  assert.match(en, /not.*(approve|decision)/i) // does this mean I'm approved
  // Still a draft. Shipping unreviewed consent text to a real borrower is the thing this flag
  // exists to prevent forgetting.
  assert.equal(CREDIT_AUTHORIZATION.reviewed, false)
  for (const locale of ['en', 'es', 'ru']) assert.ok(CREDIT_AUTHORIZATION.body[locale]?.length >= 4, locale)
})

// ── qualifying facts ────────────────────────────────────────────────────────
// The four numbers a processor would otherwise compute by hand, and the ones the program list
// is measured against. Every one of them is null-rather-than-guess, because a DTI computed from
// an income we do not have is a wrong number that looks like a right one — and gets quoted.

test('the representative score is the middle of three, not the average', () => {
  // Averaging is the intuitive thing and it is wrong in the direction that qualifies people who
  // do not qualify. 620/700/780 averages to 700 and the real number is 700 — but 580/600/780
  // averages to 653 and the real number is 600.
  assert.equal(representativeScore({ equifax: 580, experian: 600, transUnion: 780 }).score, 600)
  assert.equal(representativeScore({ equifax: 728, experian: 741, transUnion: 733 }).score, 733)
})

test('two bureaus means the lower, and one means it is not a middle score at all', () => {
  const two = representativeScore({ equifax: 700, experian: 660 })
  assert.equal(two.score, 660)
  assert.equal(two.bureaus, 2)
  const one = representativeScore({ experian: 700 })
  assert.equal(one.score, 700)
  assert.match(one.basis, /not a middle score/)
})

test('an impossible score is not a score', () => {
  assert.equal(representativeScore({ equifax: 0, experian: 9999, transUnion: null }).score, null)
})

test('with two borrowers the file takes the lower representative score', () => {
  const f = fileScore([
    representativeScore({ equifax: 760, experian: 770, transUnion: 780 }),
    representativeScore({ equifax: 640, experian: 650, transUnion: 660 }),
  ])
  assert.equal(f.score, 650)
})

test('qualifying income annualizes by pay frequency, and refuses to guess without one', () => {
  // Assuming monthly for a weekly payer understates their income more than fourfold.
  const weekly = qualifyingIncome({ documents: { paystubs_30d: [{ grossPay: 1000, payFrequency: 'weekly' }] } })
  assert.equal(weekly.monthly, round2(1000 * 52 / 12))
  assert.equal(weekly.documented, true)

  const noFreq = qualifyingIncome({ documents: { paystubs_30d: [{ grossPay: 1000 }] } })
  assert.equal(noFreq.monthly, null)
})

test('a stated income is usable but never passes as documented', () => {
  const stated = qualifyingIncome({ application: { monthlyIncome: 9000 } })
  assert.equal(stated.monthly, 9000)
  assert.equal(stated.documented, false)
  assert.match(stated.basis, /not yet documented/)
})

test('income is never the average of disagreeing sources', () => {
  // Averaging would hide the very discrepancy incomeConsistency exists to raise, and produce a
  // qualifying income nobody can support.
  const both = qualifyingIncome({
    documents: { paystubs_30d: [{ grossPay: 4000, payFrequency: 'monthly' }], w2_2yr: [{ wagesTipsOther: 120000 }] },
    application: { monthlyIncome: 9000 },
  })
  assert.equal(both.monthly, 4000)
  assert.equal(both.source, 'paystubs_30d')
})

test('a tradeline with no payment is a gap, not a zero', () => {
  // Treating it as zero is exactly how a DTI comes out too low.
  const d = monthlyDebt({ creditLiabilities: [{ monthlyPayment: 320 }, { monthlyPayment: null }, { monthlyPayment: 0 }] })
  assert.equal(d.monthly, 320)
  assert.equal(d.counted, 1)
  assert.equal(d.unknownPayments, 2)
  assert.match(d.basis, /without one/)
})

test('DTI is null unless both inputs exist, and says which one is missing', () => {
  const none = debtToIncome({ income: { monthly: null }, debt: { monthly: 500 } })
  assert.equal(none.percent, null)
  assert.deepEqual(none.missing, ['qualifying income'])
})

test('DTI names which ratio it is', () => {
  // A back-end 41% and a debts-only 41% mean different things and meet different guidelines.
  const partial = debtToIncome({ income: { monthly: 10000 }, debt: { monthly: 1500 } })
  assert.equal(partial.percent, 15)
  assert.match(partial.kind, /no proposed housing/)

  const full = debtToIncome({ income: { monthly: 10000 }, debt: { monthly: 1500 }, proposedHousing: 2500 })
  assert.equal(full.percent, 40)
  assert.equal(full.kind, 'back-end')
})

test('LTV uses the lower of price and appraisal', () => {
  // A property that appraised high does not raise the borrowable amount on a purchase.
  const high = loanToValue({ loanAmount: 400000, purchasePrice: 500000, appraisedValue: 560000 })
  assert.equal(high.percent, 80)
  assert.equal(high.basisValue, 500000)

  const low = loanToValue({ loanAmount: 400000, purchasePrice: 500000, appraisedValue: 450000 })
  assert.equal(low.percent, round2(400000 / 450000 * 100))
})

test('LTV with nothing to divide by is null and says so', () => {
  const r = loanToValue({ loanAmount: 400000 })
  assert.equal(r.percent, null)
  assert.deepEqual(r.missing, ['purchase price or appraised value'])
})

test('the whole derivation runs off one context and reports what is still missing', () => {
  const ctx = buildAnalysisContext({
    asOf: AS_OF,
    extractions: [
      read('credit_report', { equifaxScore: 612, experianScore: 640, transUnionScore: 655 }, {
        tradelines: [{ creditorName: 'Discover', monthlyPayment: 340, confidence: 0.95 }],
      }),
      read('paystubs_30d', { grossPay: 4200, payFrequency: 'semimonthly' }),
      read('purchase_contract', { purchasePrice: 620000 }),
    ],
  })
  const f = qualifyingFacts(ctx, { loanAmount: 496000 })

  assert.equal(f.creditScore.score, 640, 'middle of the three')
  assert.equal(f.income.monthly, round2(4200 * 24 / 12))
  assert.equal(f.debt.monthly, 340)
  assert.equal(f.ltv.percent, 80)
  assert.ok(f.dti.percent > 0)
  // The proposed housing payment does not exist until a loan is structured, and the file says so
  // rather than pretending the back-end ratio is known.
  assert.deepEqual(f.dti.missing, ['proposed housing payment'])
  assert.equal(f.ready, true)
})

test('an empty file yields no numbers and names every one it could not compute', () => {
  const f = qualifyingFacts(buildAnalysisContext({}), {})
  assert.equal(f.creditScore.score, null)
  assert.equal(f.income.monthly, null)
  assert.equal(f.dti.percent, null)
  assert.equal(f.ltv.percent, null)
  assert.equal(f.ready, false)
  assert.deepEqual(f.missing, ['credit score', 'qualifying income', 'debt-to-income', 'loan-to-value'])
})

test('the derived score is what actually drives the program list', () => {
  // The seam a smoke test caught: the panel used to read creditScore off the application, which
  // is empty on a document-first file, so every program "fit" no matter what the report said.
  const ctx = buildAnalysisContext({
    extractions: [read('credit_report', { equifaxScore: 600, experianScore: 612, transUnionScore: 618 })],
  })
  const f = qualifyingFacts(ctx, {})
  const fit = programFit({ creditScore: f.creditScore.score, ltv: f.ltv.percent, dti: f.dti.percent })
  assert.equal(f.creditScore.score, 612)
  assert.ok(fit.notSuitable.some((p) => p.key === 'conventional'))
  assert.ok(fit.suitable.some((p) => p.key === 'fha'))
})

const round2 = (n) => Math.round(n * 100) / 100
