// Regulatory/compliance readiness is a versioned control plane, not an underwriting rule.
//
// This catalog answers two narrow questions:
//   1. Which official application/form source governs the selected program?
//   2. Which operational controls still prevent OurMTG from representing the workflow as ready?
//
// It deliberately does NOT turn a government handbook into guessed borrower document requests.
// Program/investor overlays change, and applicability depends on facts that may not be known yet.
// Unknown applicability is a blocker, never "not required". Compliance must review a catalog
// revision before an operator can rely on it.

export const REGULATORY_CATALOG_VERSION = '2026-08-08.1'
export const REGULATORY_CATALOG_VERIFIED_AT = '2026-08-08'

export const REGULATORY_SOURCES = Object.freeze({
  urla: Object.freeze({
    id: 'urla-1003-2021',
    authority: 'Fannie Mae / Freddie Mac',
    title: 'Uniform Residential Loan Application (Form 1003/65)',
    sourceRevision: '01/2021',
    url: 'https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-residential-loan-application',
  }),
  scif: Object.freeze({
    id: 'scif-1103-2023',
    authority: 'Fannie Mae / Freddie Mac',
    title: 'Supplemental Consumer Information Form (Form 1103)',
    sourceRevision: 'mandatory for covered GSE deliveries with application dates on/after 2023-03-01',
    url: 'https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-residential-loan-application',
  }),
  fha: Object.freeze({
    id: 'hud-92900-a',
    authority: 'U.S. Department of Housing and Urban Development',
    title: 'HUD Addendum to Uniform Residential Loan Application (HUD-92900-A)',
    sourceRevision: 'current HUD forms catalog; exact edition must be locked at review',
    url: 'https://www.hud.gov/program_offices/administration/hudclips/forms/hud1',
  }),
  usda: Object.freeze({
    id: 'rd-3555-origination',
    authority: 'USDA Rural Development',
    title: 'Handbook 3555 / Form RD 3555-21 / GRH Loan Checklist',
    sourceRevision: 'current Loan Origination resource set; exact editions must be locked at review',
    url: 'https://www.rd.usda.gov/resources/usda-linc-training-resource-library/loan-origination',
  }),
  va: Object.freeze({
    id: 'va-pamphlet-26-7',
    authority: 'U.S. Department of Veterans Affairs',
    title: 'VA Pamphlet 26-7, Lenders Handbook',
    sourceRevision: 'current handbook plus effective circulars; chapter revisions must be locked at review',
    url: 'https://benefits.va.gov/HOMELOANS/lenders_nsaaa.asp',
  }),
  regBRetention: Object.freeze({
    id: 'reg-b-1002-12',
    authority: 'Consumer Financial Protection Bureau',
    title: 'Regulation B — 12 CFR § 1002.12 record retention',
    sourceRevision: 'current regulation',
    url: 'https://www.consumerfinance.gov/rules-policy/regulations/1002/12/',
  }),
  regBIncomplete: Object.freeze({
    id: 'reg-b-1002-9',
    authority: 'Consumer Financial Protection Bureau',
    title: 'Regulation B — 12 CFR § 1002.9 notifications/incomplete applications',
    sourceRevision: 'current regulation and official interpretation',
    url: 'https://www.consumerfinance.gov/rules-policy/regulations/1002/9/',
  }),
  trid: Object.freeze({
    id: 'trid-application-trigger',
    authority: 'Consumer Financial Protection Bureau',
    title: 'TILA-RESPA Integrated Disclosure application/Loan Estimate requirements',
    sourceRevision: 'current CFPB implementation guidance and FAQs',
    url: 'https://www.consumerfinance.gov/compliance/compliance-resources/mortgage-resources/tila-respa-integrated-disclosures/tila-respa-integrated-disclosure-faqs/',
  }),
  regP: Object.freeze({
    id: 'reg-p-privacy',
    authority: 'Consumer Financial Protection Bureau',
    title: 'Regulation P — privacy of consumer financial information',
    sourceRevision: 'current regulation',
    url: 'https://www.consumerfinance.gov/rules-policy/regulations/1016/',
  }),
  safeguards: Object.freeze({
    id: 'ftc-safeguards-rule',
    authority: 'Federal Trade Commission',
    title: 'FTC Safeguards Rule',
    sourceRevision: '2021 rule as amended in 2023; incident reporting effective 2024',
    url: 'https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know',
  }),
})

const PROGRAM_ALIASES = Object.freeze({
  conventional: 'conventional', conv: 'conventional', jumbo: 'conventional',
  fha: 'fha', va: 'va', usda: 'usda', rural: 'usda',
})

export function normalizeProgram(value) {
  return PROGRAM_ALIASES[String(value || '').trim().toLowerCase()] || null
}

function form(source, applicability, reason) {
  return { sourceId: source.id, title: source.title, applicability, reason }
}

/** Official application/form sources that require a controlled implementation for this file. */
export function requiredRegulatoryForms({ loanType, gseDelivery = null, applicationDate = null } = {}) {
  const program = normalizeProgram(loanType)
  const forms = [form(REGULATORY_SOURCES.urla, 'required', 'Base residential loan application source.')]

  if (program === 'conventional') {
    const onOrAfterMandate = !applicationDate || String(applicationDate).slice(0, 10) >= '2023-03-01'
    if (onOrAfterMandate && gseDelivery === true) {
      forms.push(form(REGULATORY_SOURCES.scif, 'required', 'Covered GSE delivery.'))
    } else if (onOrAfterMandate && gseDelivery == null) {
      forms.push(form(REGULATORY_SOURCES.scif, 'undetermined', 'GSE delivery channel is not recorded.'))
    }
  }
  if (program === 'fha') forms.push(form(REGULATORY_SOURCES.fha, 'required', 'FHA program overlay.'))
  if (program === 'usda') forms.push(form(REGULATORY_SOURCES.usda, 'required', 'USDA guaranteed-loan overlay.'))
  if (program === 'va') forms.push(form(REGULATORY_SOURCES.va, 'required', 'VA-guaranteed-loan overlay.'))

  return { program, forms }
}

const CONTROL_LABELS = Object.freeze({
  internalMfaEnforced: 'Internal-user MFA/AAL2 enforcement is not enabled and acceptance-verified.',
  documentScannerConfigured: 'A production malware scanner has not affirmatively cleared the document path.',
  retentionPolicyApproved: 'The record-retention and legal-hold schedule has not been approved.',
  controlledTextsReviewed: 'The 1003 attestation and credit-authorization texts are still drafts.',
  fieldCoverageApproved: 'URLA/ULAD field coverage has not been approved as complete.',
  programCatalogApproved: 'This regulatory catalog revision has not been approved by compliance.',
  tridTriggerImplemented: 'The six-piece application trigger and disclosure handoff are not implemented and verified.',
  regBNotificationsImplemented: 'Incomplete/application notification timing is not implemented and verified.',
  privacyProgramApproved: 'Privacy notices, service-provider use, and data-handling disclosures are not approved.',
})

/**
 * Deterministic deployment/file readiness. This is intentionally separate from loanReadiness:
 * a complete borrower file can still sit behind an operational compliance blocker.
 */
export function regulatoryReadiness({
  loanType, gseDelivery = null, applicationDate = null, controls = {},
} = {}) {
  const { program, forms } = requiredRegulatoryForms({ loanType, gseDelivery, applicationDate })
  const blockers = []

  if (!program) blockers.push({ code: 'program_unknown', message: 'Loan program is missing or unsupported; no overlay may be assumed.' })
  for (const item of forms.filter((entry) => entry.applicability === 'undetermined')) {
    blockers.push({ code: `applicability_${item.sourceId}`, message: item.reason })
  }
  for (const [key, message] of Object.entries(CONTROL_LABELS)) {
    if (controls[key] !== true) blockers.push({ code: key, message })
  }

  return {
    status: blockers.length ? 'blocked' : 'ready_for_controlled_pilot',
    catalogVersion: REGULATORY_CATALOG_VERSION,
    verifiedAt: REGULATORY_CATALOG_VERIFIED_AT,
    program,
    forms,
    blockers,
    meaning: blockers.length
      ? 'The application/document workflow has unresolved operational or compliance controls.'
      : 'Configured controls and this catalog revision are ready for a controlled pilot.',
    notMeaning: [
      'legal advice', 'an approval or denial', 'program eligibility',
      'proof that every investor overlay has been satisfied',
    ],
  }
}
