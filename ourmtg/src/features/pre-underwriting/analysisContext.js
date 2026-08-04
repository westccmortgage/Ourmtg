// Autopilot Pre-Underwriting — assembling what the rules reason over.
//
// Every layer so far has been able to pretend the others exist. This is where they actually
// meet: stored extractions from Level 2, the borrower's own answers from the 1003, and the
// checklist for this loan, turned into the single context object rules.js reads.
//
// It is pure, and it is the reason the whole thing is testable end to end without a database.
//
// ── The one judgement it makes ──────────────────────────────────────────────
// WHICH EXTRACTION COUNTS. A document can be read more than once — a better scan arrives, a
// processor corrects a value, the model is re-run after a prompt change. Only the newest
// non-superseded read of each document is reasoned from. Stacking all of them would produce
// "the borrower's name appears in four forms" out of one document read four times.
//
// ── What it deliberately does not do ────────────────────────────────────────
// It does not decide anything. No thresholds, no conclusions, no scoring. It arranges facts so
// that the rules — which are readable, testable and arguable — can do that.

import { getDocumentType } from './documentCatalog.js'
import { toPart, toEvidence, toCreditLiabilities } from './extractionContract.js'

/**
 * @param {object} input
 * @param {Array<object>} input.extractions   validated Level 2 values, newest first is not assumed
 * @param {object} [input.application]        the borrower's own answers (from the 1003)
 * @param {number} [input.asOf]
 * @param {(seed: string) => string} [input.id]  deterministic finding ids
 * @returns {object} the context rules.js reads
 */
export function buildAnalysisContext(input = {}) {
  const live = newestPerDocument(input.extractions || [])

  const documents = {}
  const extractions = []
  for (const e of live) {
    if (!e.docKey) continue
    const part = toPart(e)
    if (part) (documents[e.docKey] ||= []).push(part)
    for (const ev of toEvidence(e, { documentId: e.documentId })) extractions.push(ev)
  }

  return {
    documents,
    extractions,
    creditLiabilities: toCreditLiabilities(live),
    deposits: depositsFrom(live),
    employment: employmentFrom(documents, input.application),
    application: input.application || {},
    asOf: input.asOf ?? Date.now(),
    id: input.id,
  }
}

/**
 * The newest live read of each document.
 *
 * Superseded reads are excluded outright — they are history, not evidence — and among what
 * remains the latest per document wins. Reading the same bank statement twice must not make the
 * file look like it contains two bank statements.
 */
export function newestPerDocument(extractions) {
  const byDoc = new Map()
  for (const e of extractions || []) {
    if (!e || e.supersededBy) continue
    const key = e.documentId || `${e.docKey}:${byDoc.size}`
    const prior = byDoc.get(key)
    if (!prior || at(e) >= at(prior)) byDoc.set(key, e)
  }
  return [...byDoc.values()]
}

const at = (e) => {
  const t = Date.parse(String(e?.createdAt ?? ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * Deposits worth a rule's attention.
 *
 * Level 2 reads a statement's totals, not its transaction lines — a full transaction ledger is
 * a different extraction problem and reading it badly is worse than not reading it. So what
 * this returns is whatever a caller has genuinely collected, and an empty list means "we have
 * not looked", NOT "there is nothing there". largeDeposits produces no findings from an empty
 * list, which is the correct behaviour for absence and the reason it is safe to leave this
 * conservative until transaction-level reads exist.
 */
function depositsFrom(live) {
  const out = []
  for (const e of live) {
    for (const d of e?.deposits || []) {
      out.push({
        amount: d.amount,
        date: d.date || null,
        docKey: e.docKey,
        documentId: e.documentId,
        confidence: d.confidence ?? e.minFieldConfidence ?? null,
      })
    }
  }
  return out
}

/**
 * When this job started, preferring what the borrower said over what a document implies.
 *
 * The borrower is authoritative about their own employment history; a pay stub only proves they
 * were paid in a period. Getting this backwards would make incomeConsistency fire on every
 * borrower whose stub happens to be recent.
 */
function employmentFrom(documents, application) {
  const stated = application?.employmentStartDate || application?.employment?.startDate || null
  if (stated) return { startDate: stated, source: 'application' }

  const stub = documents.paystubs_30d?.[0]
  if (stub?.employmentStartDate) return { startDate: stub.employmentStartDate, source: 'paystubs_30d' }
  return {}
}

/**
 * The checklist for this loan: which documents it actually needs.
 *
 * Derived from the loan itself rather than fixed, because asking a cash-out refinance borrower
 * for a purchase contract — or a W-2 employee for a business licence — is how a file stalls on
 * a document that was never relevant.
 *
 * @param {object} loan  { purpose, occupancy, program, selfEmployed, propertyType, hasCoBorrower }
 * @returns {Array<{docKey: string, required: boolean}>}
 */
export function checklistFor(loan = {}) {
  const purpose = String(loan.purpose || '').toLowerCase()
  const program = String(loan.program || '').toLowerCase()
  const keys = ['id_photo', 'credit_report']

  if (loan.selfEmployed) keys.push('business_lic', 'bank_12mo')
  else keys.push('paystubs_30d', 'w2_2yr')

  keys.push('bank_2mo')

  if (purpose.includes('purchase')) keys.push('purchase_contract')
  else keys.push('mortgage_statement', 'hoi_dec', 'tax_bill')

  if (loan.hasRentalIncome) keys.push('lease_rentroll')
  if (program.includes('va')) keys.push('coe', 'dd214')

  // Never twice, and never a key the catalog does not know — the checklist is the contract the
  // borrower's screen and the processor's panel both render from.
  return [...new Set(keys)]
    .filter((k) => getDocumentType(k))
    .map((docKey) => ({ docKey, required: true }))
}
