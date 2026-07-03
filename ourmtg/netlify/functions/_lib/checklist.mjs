// Document-checklist definitions for the OurMTG borrower portal.
//
// Required documents are derived from the loan file's loan_type + purpose. Each item
// has a BORROWER-FACING label (what the borrower sees) and an optional INTERNAL note
// (LO-only — never returned to a portal/borrower caller). The portal-checklist
// function joins these against loan_documents rows to compute uploaded vs missing.
//
// MVP: a pragmatic, single-borrower checklist. Not a full 1003 doc matrix. `who`
// defaults to 'borrower'; co-borrower doc collection is a later enhancement.

// Base documents every residential file needs. `why` is the borrower-facing one-line
// explanation (first-time buyers don't know why anyone wants anything — telling them
// is the single cheapest trust-builder we have).
const BASE = [
  { doc_key: 'id_photo',    label: 'Government-issued photo ID (front & back)', why: 'Confirms you are you — federal law requires it on every loan.', internal: 'CIP/KYC. Unexpired.' },
  { doc_key: 'paystubs_30d', label: 'Pay stubs — most recent 30 days',          why: 'Shows your income is steady right now.', internal: 'All jobs. Must cover 30 consecutive days.' },
  { doc_key: 'w2_2yr',      label: 'W-2 forms — last 2 years',                  why: 'Proves two years of income history — the standard the loan is priced on.', internal: 'Wage earners. 2 years per employer.' },
  { doc_key: 'bank_2mo',    label: 'Bank statements — 2 most recent months',    why: 'Shows your down payment exists and is your own money.', internal: 'ALL pages, all asset accounts. Sourcing on large deposits.' },
]

// Purpose add-ons (refinances need the current-loan docs; purchases add the contract).
const REFI = [
  { doc_key: 'mortgage_statement', label: 'Current mortgage statement',            why: 'Tells us exactly what your current loan costs to pay off.', internal: 'Most recent. Verify payoff + payment history.' },
  { doc_key: 'hoi_dec',            label: 'Homeowners insurance declaration page',  why: 'Every lender requires the home to be insured — this is the proof.', internal: 'Active policy, dwelling coverage >= loan.' },
  { doc_key: 'tax_bill',           label: 'Most recent property tax bill',          why: 'Sets your escrow correctly so payments never surprise you.', internal: 'For escrow/impounds.' },
]
const PURCHASE = [
  { doc_key: 'purchase_contract', label: 'Signed purchase contract (if you have one)', why: 'Locks the price and dates everyone on the file works from.', internal: 'Include all addenda when available.' },
]

// Loan-type add-ons.
const BY_TYPE = {
  VA: [
    { doc_key: 'coe',    label: 'VA Certificate of Eligibility (COE)', why: 'Unlocks your $0-down VA benefit.', internal: 'Or DD-214 to order COE.' },
    { doc_key: 'dd214',  label: 'DD-214 (if available)',              why: 'Backs up your VA eligibility if the COE needs ordering.', internal: 'Character of service.' },
  ],
  Jumbo: [
    { doc_key: 'reserves', label: 'Reserve/asset statements (additional 2 months)', why: 'Jumbo investors want to see cushion left after closing.', internal: 'Jumbo reserve requirement varies by investor.' },
  ],
  'Non-QM': [
    { doc_key: 'bank_12mo',    label: 'Bank statements — 12 months',          why: 'Your bank statements replace tax returns for qualifying.', internal: 'Bank-statement program: replaces paystubs/W-2.' },
    { doc_key: 'business_lic', label: 'Business license / CPA letter',        why: 'Confirms the business is real and established.', internal: 'Self-employment proof + time in business.' },
  ],
  DSCR: [
    { doc_key: 'lease_rentroll', label: 'Lease agreements / rent roll',       why: 'On this program the property’s income qualifies, not yours.', internal: 'DSCR qualifies on property cash flow.' },
    { doc_key: 'hoi_dec',        label: 'Homeowners insurance declaration',   why: 'Every lender requires the property to be insured.', internal: 'Investor property coverage.' },
  ],
}

// Types whose income is documented via bank statements, NOT paystubs/W-2 — drop the
// wage-earner docs so the borrower isn't asked for things that don't apply.
const NON_WAGE_TYPES = new Set(['Non-QM', 'DSCR'])

// Build the checklist for a loan file. Returns an ordered array of
// { doc_key, label, who, internal }. `internal` is stripped by the portal endpoint
// for non-LO callers.
export function checklistFor({ loanType, purpose } = {}) {
  const type = loanType || 'Conventional'
  const isRefi = /refi|heloc/i.test(purpose || '')

  let items = []
  // Income docs — skip wage-earner docs for bank-statement/DSCR programs.
  if (NON_WAGE_TYPES.has(type)) {
    items.push(BASE.find((d) => d.doc_key === 'id_photo'))
    items.push(BASE.find((d) => d.doc_key === 'bank_2mo'))
  } else {
    items.push(...BASE)
  }

  if (isRefi) items.push(...REFI)
  else items.push(...PURCHASE)

  if (BY_TYPE[type]) items.push(...BY_TYPE[type])

  // De-dupe by doc_key (e.g. hoi_dec may appear via both refi and DSCR), keep first.
  const seen = new Set()
  const out = []
  for (const it of items) {
    if (!it || seen.has(it.doc_key)) continue
    seen.add(it.doc_key)
    out.push({ doc_key: it.doc_key, label: it.label, who: 'borrower', why: it.why || null, internal: it.internal || null })
  }
  return out
}

// Whether a doc_key is valid for a given loan file — guards the upload endpoint so a
// borrower can't create arbitrary document slots.
export function isValidDocKey({ loanType, purpose }, docKey) {
  return checklistFor({ loanType, purpose }).some((d) => d.doc_key === docKey)
}

export function labelForDocKey({ loanType, purpose }, docKey) {
  return checklistFor({ loanType, purpose }).find((d) => d.doc_key === docKey)?.label || docKey
}
