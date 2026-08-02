// Autopilot Pre-Underwriting — what a mortgage document is, and what makes it complete.
//
// This is the allowlist the intake cannot escape, the same role applicationCatalog.js plays for
// the 1003: a model may propose which entry an upload matches, but it can never invent a type,
// change what completeness means, or decide that something incomplete is fine. Those are rules,
// and rules live here as data.
//
// Keys match loan_documents.doc_key exactly, so a classified upload files itself against the
// checklist the borrower already sees rather than creating a parallel vocabulary.
//
// AUDIENCE (see docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md). Every gap this catalog can produce is
// phrased as something to send — a request, not a conclusion. Requests are safe to show the
// borrower; conclusions about them are not, and none are produced here.

/**
 * @typedef {object} DocType
 * @property {string} key            matches loan_documents.doc_key
 * @property {string} label          borrower-facing name
 * @property {string[]} hints        phrases that identify the document in its own text
 * @property {object} completeness   declarative rules — see assessCompleteness
 * @property {string[]} extract      fields worth pulling, for the team's use
 */

/** @type {Record<string, DocType>} */
export const DOCUMENT_TYPES = Object.freeze({
  id_photo: {
    key: 'id_photo',
    label: 'Government-issued photo ID',
    hints: ['driver license', 'driver’s license', 'identification card', 'passport', 'state id'],
    completeness: { sides: ['front', 'back'], mustNotBeExpired: true },
    extract: ['fullName', 'dateOfBirth', 'expirationDate', 'issuingState', 'address'],
  },
  paystubs_30d: {
    key: 'paystubs_30d',
    label: 'Pay stubs — most recent 30 days',
    hints: ['earnings statement', 'pay stub', 'paystub', 'gross pay', 'ytd gross', 'pay period'],
    // 30 consecutive days, not "one stub" — a monthly payer covers it with one, a weekly payer
    // needs four, and the rule should not have to know which.
    completeness: { coversDays: 30, freshWithinDays: 45, contiguous: true },
    extract: ['employerName', 'employeeName', 'payPeriodStart', 'payPeriodEnd', 'grossPay', 'ytdGross', 'payFrequency'],
  },
  w2_2yr: {
    key: 'w2_2yr',
    label: 'W-2 forms — last 2 years',
    hints: ['w-2', 'wage and tax statement', 'form w-2'],
    completeness: { taxYears: 2, mostRecentYears: true },
    extract: ['taxYear', 'employerName', 'employerEIN', 'employeeName', 'wagesTipsOther'],
  },
  bank_2mo: {
    key: 'bank_2mo',
    label: 'Bank statements — 2 most recent months',
    hints: ['statement period', 'beginning balance', 'ending balance', 'deposits and additions'],
    completeness: { months: 2, contiguous: true, freshWithinDays: 60, allPages: true },
    extract: ['institutionName', 'accountHolder', 'accountLast4', 'statementMonth', 'beginningBalance', 'endingBalance', 'totalDeposits'],
  },
  bank_12mo: {
    key: 'bank_12mo',
    label: 'Bank statements — 12 months',
    hints: ['statement period', 'beginning balance', 'ending balance'],
    completeness: { months: 12, contiguous: true, freshWithinDays: 60, allPages: true },
    extract: ['institutionName', 'accountHolder', 'accountLast4', 'statementMonth', 'beginningBalance', 'endingBalance', 'totalDeposits'],
  },
  reserves: {
    key: 'reserves',
    label: 'Reserve / asset statements',
    hints: ['brokerage', 'retirement account', 'ira', '401(k)', 'account summary', 'vested balance'],
    completeness: { months: 2, contiguous: true, freshWithinDays: 60, allPages: true },
    extract: ['institutionName', 'accountHolder', 'accountLast4', 'statementMonth', 'endingBalance'],
  },
  mortgage_statement: {
    key: 'mortgage_statement',
    label: 'Current mortgage statement',
    hints: ['principal balance', 'escrow balance', 'loan number', 'payment due', 'mortgage statement'],
    completeness: { freshWithinDays: 60 },
    extract: ['servicerName', 'loanNumber', 'principalBalance', 'monthlyPayment', 'escrowIncluded', 'propertyAddress', 'nextDueDate'],
  },
  hoi_dec: {
    key: 'hoi_dec',
    label: 'Homeowners insurance declaration page',
    hints: ['declarations page', 'dwelling coverage', 'policy period', 'homeowners policy'],
    completeness: { policyPeriodCoversToday: true },
    extract: ['carrierName', 'policyNumber', 'policyStart', 'policyEnd', 'dwellingCoverage', 'annualPremium', 'propertyAddress'],
  },
  tax_bill: {
    key: 'tax_bill',
    label: 'Property tax bill',
    hints: ['secured property tax', 'assessor', 'parcel number', 'tax year', 'installment'],
    completeness: { mostRecentTaxYear: true },
    extract: ['taxYear', 'parcelNumber', 'annualAmount', 'propertyAddress'],
  },
  purchase_contract: {
    key: 'purchase_contract',
    label: 'Signed purchase contract',
    hints: ['purchase agreement', 'residential purchase', 'offer to purchase', 'escrow', 'earnest money'],
    completeness: { signedByAllParties: true, allPages: true },
    extract: ['propertyAddress', 'purchasePrice', 'earnestMoney', 'closeOfEscrowDate', 'buyerNames', 'sellerNames'],
  },
  lease_rentroll: {
    key: 'lease_rentroll',
    label: 'Lease agreements / rent roll',
    hints: ['lease agreement', 'rent roll', 'monthly rent', 'tenant', 'term of lease'],
    completeness: { signedByAllParties: true },
    extract: ['propertyAddress', 'monthlyRent', 'leaseStart', 'leaseEnd', 'tenantNames'],
  },
  business_lic: {
    key: 'business_lic',
    label: 'Business license / CPA letter',
    hints: ['business license', 'certified public accountant', 'certificate of good standing', 'dba'],
    completeness: { freshWithinDays: 365 },
    extract: ['businessName', 'issuedDate', 'expirationDate', 'ownershipPercent'],
  },
  coe: {
    key: 'coe',
    label: 'VA Certificate of Eligibility',
    hints: ['certificate of eligibility', 'entitlement code', 'department of veterans affairs'],
    completeness: {},
    extract: ['veteranName', 'entitlementCode', 'entitlementAmount', 'fundingFeeStatus'],
  },
  dd214: {
    key: 'dd214',
    label: 'DD-214',
    hints: ['dd form 214', 'certificate of release', 'character of service'],
    completeness: {},
    extract: ['veteranName', 'characterOfService', 'separationDate'],
  },
})

export const DOCUMENT_KEYS = Object.freeze(Object.keys(DOCUMENT_TYPES))

export const isKnownDocumentType = (key) => Object.hasOwn(DOCUMENT_TYPES, key)
export const getDocumentType = (key) => (isKnownDocumentType(key) ? DOCUMENT_TYPES[key] : null)

// Documents whose contents are read but never surfaced to a borrower beyond "we have it".
// Identity documents in particular: echoing a scanned licence number back onto a web page is
// a needless exposure of exactly the data the file exists to protect.
export const NEVER_ECHOED = Object.freeze(['id_photo'])
