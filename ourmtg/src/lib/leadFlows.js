// Lead-flow definitions. Each flow posts the shared lead shape to GRCRM's lead-inbound
// webhook with a `source`/tag so routing + automations can branch (spec §I.1, §E.4).
// The webhook dedupes by email/phone and arms the correct workflow.

export const LOAN_TYPES = ['Conventional', 'FHA', 'VA', 'Jumbo', 'USDA', 'Non-QM', 'DSCR']
export const PURPOSES = ['Purchase', 'Rate-Term Refi', 'Cash-out Refi', 'HELOC']

// Exact consent disclosure captured with the lead (TCPA/CAN-SPAM — spec §M).
export const SMS_CONSENT_TEXT =
  'By checking this box, I agree to receive calls and text messages (including via automated ' +
  'technology) and emails from West Coast Capital Mortgage at the number and address provided, ' +
  'including about my loan inquiry. Consent is not a condition of any purchase. Message and data ' +
  'rates may apply. Reply STOP to opt out of texts at any time.'

// Build the lead-inbound payload from a borrower intake form.
export function borrowerLeadPayload(form) {
  return {
    source: 'ourmtg_intake',
    tags: ['OurMTG', 'Borrower intake', form.loanType, form.purpose].filter(Boolean),
    firstName: form.firstName,
    lastName: form.lastName,
    name: [form.firstName, form.lastName].filter(Boolean).join(' '),
    email: form.email,
    phone: form.phone,
    loanType: form.loanType,
    purpose: form.purpose,
    message: form.message || null,
    consent: {
      sms: !!form.consent,
      email: !!form.consent,
      text: SMS_CONSENT_TEXT,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
    },
  }
}

// Build the lead-inbound payload for a realtor buyer referral (spec §K.8, workflow #21).
export function realtorLeadPayload(form, partner) {
  return {
    source: 'realtor_referral',
    tags: ['OurMTG', 'Realtor referral'],
    firstName: form.firstName,
    lastName: form.lastName,
    name: [form.firstName, form.lastName].filter(Boolean).join(' '),
    email: form.email,
    phone: form.phone,
    priceRange: form.priceRange || null,
    message: form.notes || null,
    referredBy: partner
      ? { name: partner.name || null, email: partner.email || null }
      : null,
  }
}
