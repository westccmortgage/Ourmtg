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
// Each flow carries `sections` — the plain-English explainer that renders BEFORE the
// form. A borrower should understand the program (what it is, who it fits, the honest
// trade-offs) first, then choose to start. Blocks: { p } paragraph, { ul } bullet list,
// { rows: [{ t, d }] } ledger term/detail rows, { note } small caveat.
export const FLOWS = {
  dpa: {
    path: '/dpa', source: 'dpa_check', tag: 'DPA check',
    eyebrow: 'down payment assistance · california',
    title: ['own sooner,', 'with help on the down.'],
    sub: 'The down payment is the wall most first buyers hit. California has real programs that help you over it — here is how they actually work, and how to tell which ones are worth using.',
    cta: 'Check my DPA options',
    formIntro: 'Three quick questions. No credit pull, no commitment — we check what is currently open for your county and income and tell you what fits.',
    disclaimer: 'Program availability, funding, and eligibility change and are subject to program guidelines.',
    sections: [
      {
        h: 'What down-payment assistance really is',
        blocks: [
          { p: 'Down-payment assistance (DPA) is help — usually a second loan or a grant — that covers some or all of your down payment, and sometimes closing costs too. You still get a normal first mortgage; the assistance sits quietly behind it. It does not replace your loan, it lowers the cash you need to bring to the table.' },
          { p: 'That is the whole idea: get you into the home years sooner than saving the full down payment would allow, without draining every dollar you have.' },
        ],
      },
      {
        h: 'The main California programs',
        blocks: [
          { rows: [
            { t: 'CalHFA MyHome', d: 'A deferred second loan for the down payment and/or closing costs. You make no monthly payment on it — it is repaid when you sell, refinance, or pay off the first mortgage.' },
            { t: 'CalHFA first mortgages', d: 'A standard conventional or FHA first loan built to pair cleanly with CalHFA assistance so the two work together.' },
            { t: 'GSFA & city/county programs', d: 'Down-payment grants and forgivable seconds tied to income and area. Some are true grants — no repayment — and some forgive over a set number of years.' },
          ] },
          { note: 'Funding is limited and can pause mid-year when money runs out, then reopen. Timing genuinely matters — this is a big reason to check now rather than later.' },
        ],
      },
      {
        h: 'Who usually qualifies',
        blocks: [
          { ul: [
            'First-time buyer — often defined as not having owned a home in the last three years (some programs waive this).',
            'Household income at or under your county’s program limit.',
            'A minimum credit score, commonly around 640–660.',
            'Completion of a short homebuyer-education course (online, a few hours).',
            'You’ll live in the home as your primary residence.',
          ] },
        ],
      },
      {
        h: 'The honest trade-offs',
        blocks: [
          { ul: [
            'Most assistance is a second loan you repay later — not always free money. Read whether it’s deferred, forgivable, or a true grant.',
            'Income limits can exclude higher earners entirely.',
            'Layering assistance can slightly narrow which first mortgages and rates you can pair with.',
          ] },
          { p: 'None of that makes DPA a bad deal — for the right buyer it’s the difference between owning now and owning in five years. It just means the right program depends on your numbers.' },
        ],
      },
    ],
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
    sub: 'FHA is the loan the government designed for buyers who don’t have a huge down payment or a spotless credit history. Here’s exactly how it works and where it wins — and where a conventional loan might beat it.',
    cta: 'See if I qualify',
    formIntro: 'Two quick questions and your contact info. We’ll model FHA against a conventional loan so you see the real monthly and long-run cost, not just the down payment.',
    sections: [
      {
        h: 'What an FHA loan is',
        blocks: [
          { p: 'An FHA loan is insured by the Federal Housing Administration. That insurance protects the lender if a loan goes bad, which is what lets us approve buyers with lower down payments and less-than-perfect credit than a conventional loan would allow. It’s a government-backed on-ramp to ownership — not a lesser loan.' },
        ],
      },
      {
        h: 'The numbers that matter',
        blocks: [
          { rows: [
            { t: '3.5% down', d: 'With a credit score of 580 or higher. Between 500–579 the minimum is 10% down.' },
            { t: 'Mortgage insurance', d: 'An upfront premium (financed into the loan) plus a monthly premium. This is the trade you make for the low down payment.' },
            { t: 'County loan limits', d: 'FHA caps how much you can borrow, and the cap varies by county. High-cost California counties have higher limits.' },
            { t: 'Flexible ratios', d: 'FHA often allows a higher debt-to-income ratio than conventional, with compensating factors like reserves or a strong payment history.' },
          ] },
        ],
      },
      {
        h: 'FHA vs. conventional — the honest comparison',
        blocks: [
          { ul: [
            'FHA: easier credit, lower down — but the mortgage insurance usually stays for the life of the loan unless you later refinance out of it.',
            'Conventional: needs stronger credit, but the mortgage insurance drops off automatically once you reach about 20% equity.',
            'For many buyers FHA is the right first move, then a refinance to conventional later once credit and equity improve. We’ll tell you if that’s your path.',
          ] },
        ],
      },
      {
        h: 'FHA is usually a strong fit if',
        blocks: [
          { ul: [
            'Your credit is roughly in the 580–680 range.',
            'Your down payment is limited.',
            'You’ve had a past credit bump — a late stretch, a collection, a thin file.',
            'This is your first home and you want the lowest barrier to entry.',
          ] },
        ],
      },
    ],
    fields: [
      { name: 'Credit score range', type: 'select', options: ['740+', '680–739', '620–679', 'Below 620', 'Not sure'] },
      { name: 'Down payment saved', type: 'text', placeholder: '$15,000' },
    ],
  },
  va: {
    path: '/va', source: 'va_eligibility', tag: 'VA eligibility',
    eyebrow: 'va loans · $0 down · thank you for your service',
    title: ['you served.', 'the zero-down loan is yours.'],
    sub: 'The VA loan is one of the strongest mortgages in the country — and you earned it. Here’s everything it does, what the funding fee is, and how we confirm your eligibility.',
    cta: 'Confirm my eligibility',
    formIntro: 'Two quick questions and your contact info. We’ll confirm eligibility and help you pull your Certificate of Eligibility (COE).',
    sections: [
      {
        h: 'What a VA loan is',
        blocks: [
          { p: 'The VA loan is backed by the U.S. Department of Veterans Affairs and available to eligible active-duty service members, veterans, National Guard and Reserve members, and certain surviving spouses. The VA doesn’t lend the money — it guarantees part of the loan, which lets us offer terms no other program can match.' },
        ],
      },
      {
        h: 'Why it’s so strong',
        blocks: [
          { rows: [
            { t: '$0 down', d: 'On most purchases — no down payment required at all, on a primary residence.' },
            { t: 'No monthly mortgage insurance', d: 'FHA and low-down conventional loans both charge it every month. VA doesn’t. That’s real money saved on every payment.' },
            { t: 'Competitive rates', d: 'VA rates are typically among the lowest available, and some closing costs are limited or must be paid by the seller or lender.' },
            { t: 'Reusable', d: 'This is not a one-time benefit. You can use it again, and in some cases have more than one VA loan at once.' },
          ] },
        ],
      },
      {
        h: 'The VA funding fee',
        blocks: [
          { p: 'In place of monthly mortgage insurance, VA charges a one-time funding fee that can be financed into the loan. First-time use is a lower percentage than later uses, and a larger down payment reduces it further.' },
          { note: 'Veterans receiving compensation for a service-connected disability are generally exempt from the funding fee entirely.' },
        ],
      },
      {
        h: 'What you’ll need',
        blocks: [
          { ul: [
            'Your Certificate of Eligibility (COE) — we help you pull it; it confirms your entitlement to the VA benefit.',
            'Proof of service — typically the DD-214 for veterans, or a statement of service for active duty.',
            'The home must be your primary residence — VA is not for pure investment property.',
          ] },
        ],
      },
    ],
    fields: [
      { name: 'Service status', type: 'select', options: ['Veteran', 'Active duty', 'Reserves / Guard', 'Surviving spouse'] },
      { name: 'Used VA benefit before', type: 'select', options: ['No', 'Yes', 'Not sure'] },
    ],
  },
  selfEmployed: {
    path: '/self-employed', source: 'self_employed_review', tag: 'Self-employed review',
    eyebrow: 'bank-statement loans · non-qm',
    title: ['self-employed?', 'your bank statements are your W-2.'],
    sub: 'If you write off enough to keep your taxes low, your tax returns make you look like you barely earn a living — and traditional lenders believe the returns. Bank-statement loans qualify you on the money that actually moves through your accounts instead.',
    cta: 'Review my scenario',
    formIntro: 'Two quick questions and your contact info. We’ll map your income the way an underwriter will and tell you what you can realistically qualify for.',
    sections: [
      {
        h: 'Why self-employed buyers get stuck',
        blocks: [
          { p: 'Tax returns are written to minimize taxable income — that’s smart accounting. But a conventional lender qualifies you on that same low number, so a business owner who nets plenty of real cash can look, on paper, like they can barely afford a small loan. Bank-statement and other Non-QM loans fix this by looking at your actual cash flow.' },
        ],
      },
      {
        h: 'How a bank-statement loan works',
        blocks: [
          { rows: [
            { t: '12–24 months of statements', d: 'Personal or business bank statements stand in for tax returns as proof of income.' },
            { t: 'Income from real deposits', d: 'We calculate qualifying income from the deposits that actually land in your accounts, applying an expense factor — no tax returns required.' },
            { t: 'Usually 2 years in business', d: 'Most programs want a two-year track record and a somewhat larger down payment (often 10–20%).' },
            { t: 'Slightly higher rate', d: 'The rate typically runs a bit above conventional — that’s the trade for flexible documentation. Often well worth it to qualify at all.' },
          ] },
        ],
      },
      {
        h: 'Who this fits',
        blocks: [
          { ul: [
            'Business owners and the self-employed whose write-offs hide their true income.',
            '1099 contractors and gig workers.',
            'Real-estate agents, consultants, and commission earners.',
            'Anyone told “no” by a bank because their tax returns don’t reflect what they really make.',
          ] },
        ],
      },
      {
        h: 'Other doors we can open',
        blocks: [
          { ul: [
            'Profit-and-loss-only programs (a CPA-prepared P&L in place of statements).',
            'Asset-depletion loans that qualify you off your savings and investments.',
            '1099-only programs for straightforward contractor income.',
          ] },
        ],
      },
    ],
    fields: [
      { name: 'Years self-employed', type: 'select', options: ['2+', '1–2', 'Under 1'] },
      { name: 'Business type', type: 'text', placeholder: 'Contractor, salon, trucking…' },
    ],
  },
  jumbo: {
    path: '/jumbo', source: 'jumbo_readiness', tag: 'Jumbo readiness',
    eyebrow: 'jumbo · above county limits',
    title: ['bigger loan.', 'same calm process.'],
    sub: 'A jumbo loan is bigger than the limits Fannie Mae and Freddie Mac will buy, so it’s underwritten by hand to stricter standards. The buyers who win in escrow are the ones whose file was packaged right before they ever wrote an offer. Here’s what that takes.',
    cta: 'Test my readiness',
    formIntro: 'Two quick questions and your contact info. We’ll pressure-test your file against jumbo standards and flag anything that needs shoring up before you offer.',
    sections: [
      {
        h: 'What makes a loan “jumbo”',
        blocks: [
          { p: 'Every county has a conforming loan limit — the most Fannie Mae and Freddie Mac will back. Borrow above it and your loan is “jumbo”: it can’t be sold to those agencies, so a lender (or its investors) holds the risk directly. That means hand underwriting and tighter standards, judged on the strength of the whole file.' },
        ],
      },
      {
        h: 'What underwriters look at harder',
        blocks: [
          { rows: [
            { t: 'Reserves', d: 'Months of mortgage payments still in the bank after closing. Jumbo files want to see a real cushion — this is often the make-or-break factor.' },
            { t: 'Down payment', d: 'Commonly 10–20% or more, depending on the loan size and property.' },
            { t: 'Credit', d: 'Usually 700+, with a clean recent history.' },
            { t: 'Documentation', d: 'Complete, current, and fully sourced. Every large deposit must be explained and traced.' },
          ] },
        ],
      },
      {
        h: 'Why packaging is everything',
        blocks: [
          { p: 'A jumbo file is judged as one story, not a checklist. A missing statement, an unexplained transfer, or a thin reserve picture can sink an otherwise strong buyer. We assemble and pressure-test the file before you’re in contract, so an underwriter sees a clean, complete picture — and you’re not scrambling in the middle of escrow with the clock running.' },
        ],
      },
    ],
    fields: [
      { name: 'Target price range', type: 'text', placeholder: '$1.2M–$1.5M' },
      { name: 'Down payment %', type: 'select', options: ['20%+', '10–20%', 'Under 10%'] },
    ],
  },
  refi: {
    path: '/refi', source: 'refinance_review', tag: 'Refinance review',
    eyebrow: 'refinance · rate-term · cash-out · heloc',
    title: ['your rate is not', 'a life sentence.'],
    sub: 'Refinancing can save you real money — or quietly cost you money while feeling like a win. The only honest question is whether it pays for you, after costs. Here’s exactly how to tell, and when the answer is no.',
    cta: 'Review my loan',
    formIntro: 'Two quick questions and your contact info. We’ll run your break-even honestly and tell you whether refinancing pays — and if it doesn’t, we’ll say so.',
    sections: [
      {
        h: 'The three reasons people refinance',
        blocks: [
          { rows: [
            { t: 'Lower the rate or payment', d: 'Replace your loan with a cheaper one. Worth it when the monthly savings pays back the closing costs within a reasonable time.' },
            { t: 'Cash out equity', d: 'Borrow against the value you’ve built for a renovation, debt payoff, or investment — trading a bit of equity for cash in hand.' },
            { t: 'Change the loan itself', d: 'Drop mortgage insurance, shorten the term to pay off faster, or move off an adjustable rate onto a fixed one.' },
          ] },
        ],
      },
      {
        h: 'The break-even math',
        blocks: [
          { p: 'It’s one simple calculation: closing costs ÷ monthly savings = the number of months to break even. If you’ll keep the home past that point, the refinance pays. If you might sell or refinance again before then, it doesn’t — no matter how good the new rate looks.' },
          { note: 'A lower rate on a fresh 30-year term can still raise your total interest if it restarts the clock. We look at lifetime cost, not just the monthly number.' },
        ],
      },
      {
        h: 'When NOT to refinance',
        blocks: [
          { ul: [
            'You expect to move or sell before you reach break-even.',
            'The rate improvement is too small to cover the costs.',
            'You’d erase years of progress by restarting a 30-year clock with no offsetting benefit.',
          ] },
          { p: 'We’ll tell you plainly when staying put is the smarter move. A refinance that doesn’t help you isn’t a deal we want to write.' },
        ],
      },
    ],
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
