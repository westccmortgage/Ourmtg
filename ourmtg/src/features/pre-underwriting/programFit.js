// Autopilot Pre-Underwriting — which programs are worth a human looking at.
//
// THE WORD IS "SUITABILITY", NOT "ELIGIBILITY", and the difference is the whole module. Nothing
// here says a borrower qualifies. It says: given what is on file, these programs are worth a
// licensed person's time, and here is the published guideline each comparison was made against.
//
// Why that distinction is not pedantry: agency guidelines have layers this cannot see — AUS
// findings, lender overlays, appraisal, MI availability, reserves after close, the property
// itself. A screen that said "you qualify for FHA" would be wrong in a way that costs someone a
// house, and saying it is a legal act reserved to people with licences.
//
// So every result carries what it was measured against and what it did NOT check. A program is
// never removed for a reason we could not verify — only for one we could.

const PROGRAMS = Object.freeze([
  {
    key: 'conventional',
    label: 'Conventional (Fannie / Freddie)',
    minScore: 620,
    maxLtv: 97,
    maxDti: 50,
    note: 'Standard agency financing. Mortgage insurance below 20% down, removable later.',
  },
  {
    key: 'fha',
    label: 'FHA',
    minScore: 580,
    maxLtv: 96.5,
    maxDti: 57,
    note: 'Lower score tolerance and a higher DTI ceiling. Mortgage insurance is generally for the life of the loan.',
  },
  {
    key: 'va',
    label: 'VA',
    minScore: 580,
    maxLtv: 100,
    maxDti: 60,
    requiresVeteran: true,
    note: 'No down payment and no monthly mortgage insurance. Requires a Certificate of Eligibility.',
  },
  {
    key: 'usda',
    label: 'USDA Rural',
    minScore: 640,
    maxLtv: 100,
    maxDti: 46,
    requiresRural: true,
    requiresIncomeLimit: true,
    note: 'No down payment in eligible areas, with household income limits.',
  },
  {
    key: 'jumbo',
    label: 'Jumbo',
    minScore: 700,
    maxLtv: 89.99,
    maxDti: 43,
    aboveConformingOnly: true,
    note: 'Above the conforming limit. Tighter score, reserve, and documentation expectations.',
  },
  {
    key: 'non_qm',
    label: 'Non-QM / bank statement',
    minScore: 620,
    maxLtv: 90,
    maxDti: 55,
    note: 'For income that does not document conventionally — self-employed, recent credit events, investor cash flow.',
  },
])

// 2026 conforming limit for a one-unit property in most of the country. High-cost counties are
// higher, which is why crossing it is a "look at this" and never a removal.
export const CONFORMING_LIMIT = 806_500

/**
 * @param {object} file
 * @param {number|null} [file.creditScore]     middle score, if a tri-merge has been read
 * @param {number|null} [file.ltv]             percent
 * @param {number|null} [file.dti]             percent
 * @param {number|null} [file.loanAmount]
 * @param {boolean} [file.veteran]
 * @param {boolean} [file.selfEmployed]
 * @param {string} [file.occupancy]            'primary' | 'second' | 'investment'
 * @returns {{suitable: Array, notSuitable: Array, unknowns: string[], checked: string[], notChecked: string[]}}
 */
export function programFit(file = {}) {
  const score = numOrNull(file.creditScore)
  const ltv = numOrNull(file.ltv)
  const dti = numOrNull(file.dti)
  const amount = numOrNull(file.loanAmount)

  const unknowns = []
  if (score === null) unknowns.push('credit score')
  if (ltv === null) unknowns.push('loan-to-value')
  if (dti === null) unknowns.push('debt-to-income')

  const suitable = []
  const notSuitable = []

  for (const p of PROGRAMS) {
    const failed = []
    const assumed = []

    // Each comparison is made only when the number exists. An unknown is recorded as an
    // assumption, never as a pass and never as a failure — a program ruled out on a number
    // nobody has is a program ruled out on nothing.
    if (score !== null) { if (score < p.minScore) failed.push(`score ${score} is below ${p.minScore}`) }
    else assumed.push(`needs a score of at least ${p.minScore}`)

    if (ltv !== null) { if (ltv > p.maxLtv) failed.push(`${pct(ltv)} LTV is above ${pct(p.maxLtv)}`) }
    else assumed.push(`allows up to ${pct(p.maxLtv)} LTV`)

    if (dti !== null) { if (dti > p.maxDti) failed.push(`${pct(dti)} DTI is above ${pct(p.maxDti)}`) }
    else assumed.push(`allows up to ${pct(p.maxDti)} DTI`)

    if (p.requiresVeteran && file.veteran !== true) {
      // Not a failure unless we know the answer: an unanswered military-service question is not
      // a "no", and treating it as one silently removes the best program a veteran can get.
      if (file.veteran === false) failed.push('requires eligible military service')
      else assumed.push('requires eligible military service')
    }
    if (p.aboveConformingOnly && amount !== null && amount <= CONFORMING_LIMIT) {
      failed.push(`loan amount is at or below the conforming limit of ${money(CONFORMING_LIMIT)}`)
    }
    if (p.requiresRural) assumed.push('property must be in a USDA-eligible area')
    if (p.requiresIncomeLimit) assumed.push('household income must be under the county limit')
    if (p.key === 'non_qm' && file.selfEmployed === true) {
      assumed.push('bank-statement income is documented over 12–24 months')
    }

    const row = {
      key: p.key,
      label: p.label,
      note: p.note,
      guideline: `score ≥ ${p.minScore}, LTV ≤ ${pct(p.maxLtv)}, DTI ≤ ${pct(p.maxDti)}`,
      assumptions: assumed,
      reasons: failed,
    }
    if (failed.length) notSuitable.push(row)
    else suitable.push(row)
  }

  // Best-documented first: fewest unverified assumptions, then the more conventional option,
  // so the list opens with what a processor is most likely to actually pursue.
  suitable.sort((a, b) => a.assumptions.length - b.assumptions.length
    || PROGRAMS.findIndex((p) => p.key === a.key) - PROGRAMS.findIndex((p) => p.key === b.key))

  return {
    suitable,
    notSuitable,
    unknowns,
    checked: ['credit score', 'loan-to-value', 'debt-to-income', 'loan amount vs conforming limit'],
    // Named explicitly on the panel. A list of what was NOT examined is the difference between
    // a screening tool and something a reader mistakes for an underwriting decision.
    notChecked: [
      'automated underwriting findings (DU / LP)',
      'lender overlays',
      'appraisal and property condition',
      'mortgage insurance availability',
      'reserves remaining after closing',
      'title, and anything discovered in it',
    ],
  }
}

// Note what is NOT written here: Number(String(v ?? '')). Number('') is 0, so an ABSENT credit
// score would arrive as a score of zero and rule out every program on the list — an empty file
// that "qualifies for nothing", which a processor would believe.
const numOrNull = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[$,%\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const pct = (n) => `${Math.round(n * 100) / 100}%`
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`

export { PROGRAMS }
