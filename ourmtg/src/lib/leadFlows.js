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

// ── Lead-engine flows (spec §E.4) ─────────────────────────────────────────────
// Each landing page posts the shared lead shape with its own source/tag so GRCRM
// routing + automations can branch. `fields` are flow-specific qualifiers whose
// answers travel in the lead's message body (nothing is ever lost).
export const FLOWS = {
  dpa: {
    path: '/dpa', source: 'dpa_check', tag: 'DPA check',
    eyebrow: 'down payment assistance · california',
    title: ['own sooner,', 'with help on the down.'],
    sub: 'California has real down-payment assistance programs. Answer three questions and we’ll check what you may qualify for — no credit pull, no commitment.',
    cta: 'Check my DPA options',
    disclaimer: 'Program availability, funding, and eligibility change and are subject to program guidelines.',
    fields: [
      { name: 'First-time buyer', type: 'select', options: ['Yes', 'No'] },
      { name: 'Household income (yearly)', type: 'text', placeholder: '$95,000' },
      { name: 'Target county', type: 'text', placeholder: 'Los Angeles' },
    ],
  },
  fha: {
    path: '/fha', source: 'fha_qualification', tag: 'FHA qualification',
    eyebrow: 'fha loans · 3.5% down',
    title: ['first home?', 'fha was built for you.'],
    sub: 'Lower down payment, friendlier credit requirements. See if FHA fits your situation in one minute.',
    cta: 'See if I qualify',
    fields: [
      { name: 'Credit score range', type: 'select', options: ['740+', '680–739', '620–679', 'Below 620', 'Not sure'] },
      { name: 'Down payment saved', type: 'text', placeholder: '$15,000' },
    ],
  },
  va: {
    path: '/va', source: 'va_eligibility', tag: 'VA eligibility',
    eyebrow: 'va loans · $0 down · thank you for your service',
    title: ['you served.', 'the zero-down loan is yours.'],
    sub: 'VA loans: no down payment, no monthly mortgage insurance. Let’s confirm your eligibility and get your Certificate of Eligibility moving.',
    cta: 'Confirm my eligibility',
    fields: [
      { name: 'Service status', type: 'select', options: ['Veteran', 'Active duty', 'Reserves / Guard', 'Surviving spouse'] },
      { name: 'Used VA benefit before', type: 'select', options: ['No', 'Yes', 'Not sure'] },
    ],
  },
  selfEmployed: {
    path: '/self-employed', source: 'self_employed_review', tag: 'Self-employed review',
    eyebrow: 'bank-statement loans · non-qm',
    title: ['self-employed?', 'your bank statements are your W-2.'],
    sub: 'No tax-return gymnastics. We qualify business owners on real cash flow — 12 months of bank statements can be enough.',
    cta: 'Review my scenario',
    fields: [
      { name: 'Years self-employed', type: 'select', options: ['2+', '1–2', 'Under 1'] },
      { name: 'Business type', type: 'text', placeholder: 'Contractor, salon, trucking…' },
    ],
  },
  jumbo: {
    path: '/jumbo', source: 'jumbo_readiness', tag: 'Jumbo readiness',
    eyebrow: 'jumbo · above county limits',
    title: ['bigger loan.', 'same calm process.'],
    sub: 'Buying above the conforming limit takes sharper packaging — reserves, ratios, timing. Let’s pressure-test your file before you offer.',
    cta: 'Test my readiness',
    fields: [
      { name: 'Target price range', type: 'text', placeholder: '$1.2M–$1.5M' },
      { name: 'Down payment %', type: 'select', options: ['20%+', '10–20%', 'Under 10%'] },
    ],
  },
  refi: {
    path: '/refi', source: 'refinance_review', tag: 'Refinance review',
    eyebrow: 'refinance · rate-term · cash-out · heloc',
    title: ['your rate is not', 'a life sentence.'],
    sub: 'Two minutes: current loan, current rate. We’ll tell you honestly whether refinancing pays — and when it doesn’t, we’ll say so.',
    cta: 'Review my loan',
    fields: [
      { name: 'Current rate', type: 'text', placeholder: '7.25%' },
      { name: 'Goal', type: 'select', options: ['Lower payment', 'Cash out', 'Pay off faster', 'Drop MI'] },
    ],
  },
}

// Compose the lead payload for a flow landing: qualifier answers travel in `message`.
export function flowLeadPayload(flow, contact, answers) {
  const lines = [`OurMTG · ${flow.tag}`]
  for (const f of flow.fields) {
    const v = answers[f.name]
    if (v) lines.push(`${f.name}: ${v}`)
  }
  return {
    source: flow.source,
    tags: ['OurMTG', flow.tag],
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    email: contact.email,
    phone: contact.phone,
    message: lines.join('\n'),
    consent: {
      sms: !!contact.consent,
      email: !!contact.consent,
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
