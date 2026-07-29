// Conversational 1003 — deterministic conditional rules (§12).
//
// These decide what the application REQUIRES. The language model has no vote here: it cannot
// mark a field not-required, and it cannot mark one required either. Every rule is a pure
// function of the current application state, versioned with RULES_VERSION, and unit tested.
//
// A rule returns one of:
//   true   → the conditionally-required field IS required
//   false  → not required *yet* (still open — e.g. we don't know the trigger answer)
//   'n/a'  → structurally not applicable; the field resolves as not_applicable

import { RULES_VERSION } from './types.js'
import { getField, pathIndices, recordPrefix } from './applicationCatalog.js'
import { monthsBetween, monthToIndex } from './normalization.js'

// Required continuous history windows (months). Fannie/Freddie ask for two years of both.
export const REQUIRED_EMPLOYMENT_HISTORY_MONTHS = 24
export const REQUIRED_RESIDENCE_HISTORY_MONTHS = 24

// ── State readers ────────────────────────────────────────────────────────────
// `state` is the ApplicationState from applicationReducer.js. These readers only ever look at
// RESOLVED or candidate values; they never guess.

const val = (state, path) => state.fields?.[path]?.normalized_value ?? null
const statusOf = (state, path) => state.fields?.[path]?.status ?? 'missing'
const known = (state, path) => {
  const s = statusOf(state, path)
  return s === 'borrower_confirmed' || s === 'team_confirmed' || s === 'candidate'
}

/** Sibling field inside the same repeating record: recordSibling(state, 'parties[0].employment[1].startDate', 'isCurrent') */
export function recordSibling(state, path, siblingName) {
  return val(state, `${recordPrefix(path)}.${siblingName}`)
}
function siblingKnown(state, path, siblingName) {
  return known(state, `${recordPrefix(path)}.${siblingName}`)
}

// ── Rule implementations ─────────────────────────────────────────────────────
// Each receives ({ state, path }) where `path` is the INSTANTIATED path of the field whose
// requiredness is being decided.

export const RULES = Object.freeze({
  // --- Identity -------------------------------------------------------------
  alternateNamesApply: () => false, // optional prompt; never blocks completeness
  hasDependents: ({ state, path }) => {
    const n = val(state, `parties[${pathIndices(path)[0]}].dependentsCount`)
    if (n == null) return false
    return Number(n) > 0 ? true : 'n/a'
  },

  // --- Residence ------------------------------------------------------------
  residenceIsPrevious: ({ state, path }) => {
    const isCurrent = recordSibling(state, path, 'isCurrent')
    if (isCurrent == null) return false
    return isCurrent === true ? 'n/a' : true
  },
  housingExpenseApplies: ({ state, path }) => {
    const basis = recordSibling(state, path, 'occupancyBasis')
    if (basis == null) return false
    return basis === 'live_rent_free' ? 'n/a' : true
  },
  mailingAddressDiffers: ({ state, path }) => {
    const same = val(state, `parties[${pathIndices(path)[0]}].mailingAddressSameAsCurrent`)
    if (same == null) return false
    return same === true ? 'n/a' : true
  },

  // --- Employment -----------------------------------------------------------
  employmentIsPrevious: ({ state, path }) => {
    const isCurrent = recordSibling(state, path, 'isCurrent')
    if (isCurrent == null) return false
    return isCurrent === true ? 'n/a' : true
  },
  employmentIsSelfEmployed: ({ state, path }) => {
    const type = recordSibling(state, path, 'employmentType')
    if (type == null) return false
    return type === 'self_employed' ? true : 'n/a'
  },
  // Employer address is only needed for a CURRENT job (verification of employment).
  employerAddressRequired: ({ state, path }) => {
    const isCurrent = recordSibling(state, path, 'isCurrent')
    if (isCurrent == null) return false
    return isCurrent === true ? true : 'n/a'
  },

  // --- Income ---------------------------------------------------------------
  incomeIsHourly: ({ state, path }) => {
    const freq = recordSibling(state, path, 'frequency')
    if (freq == null) return false
    return freq === 'hourly' ? true : 'n/a'
  },
  incomeIsOther: ({ state, path }) => {
    const type = recordSibling(state, path, 'incomeType')
    if (type == null) return false
    return type === 'other' ? true : 'n/a'
  },
  incomeIsEmploymentLinked: ({ state, path }) => {
    const type = recordSibling(state, path, 'incomeType')
    if (type == null) return false
    const linked = ['base', 'overtime', 'bonus', 'commission', 'military', 'self_employment']
    if (!linked.includes(type)) return 'n/a'
    // Only ask which job when there is more than one to choose from.
    return countGroup(state, pathIndices(path)[0], 'employment') > 1 ? true : 'n/a'
  },

  // --- Loan / property ------------------------------------------------------
  loanIsPurchase: ({ state }) => {
    const p = val(state, 'loan.purpose')
    if (p == null) return false
    return p === 'purchase' ? true : 'n/a'
  },
  loanIsRefinance: ({ state }) => {
    const p = val(state, 'loan.purpose')
    if (p == null) return false
    return p === 'refinance' ? true : 'n/a'
  },
  refinanceIsCashOut: ({ state }) => {
    if (val(state, 'loan.purpose') !== 'refinance') return 'n/a'
    const rp = val(state, 'loan.refinancePurpose')
    if (rp == null) return false
    return rp === 'cash_out' ? true : 'n/a'
  },
  // The borrower may not have picked a house yet — that is a legitimate "unknown", not a gap.
  propertyAddressKnown: ({ state }) => {
    const p = val(state, 'loan.purpose')
    if (p == null) return false
    if (p === 'refinance') return true // they live there; the address is knowable now
    const underContract = val(state, 'loan.isUnderContract')
    if (underContract === false) return 'n/a'
    return true
  },
  titleVestingApplies: () => false, // escrow/title confirms wording; never blocks the borrower

  // --- Assets ---------------------------------------------------------------
  assetNeedsInstitution: ({ state, path }) => {
    const type = recordSibling(state, path, 'assetType')
    if (type == null) return false
    const depository = ['checking', 'savings', 'money_market', 'certificate_of_deposit',
      'mutual_fund', 'stocks', 'bonds', 'retirement', 'trust']
    return depository.includes(type) ? true : 'n/a'
  },
  assetIsGiftOrGrant: ({ state, path }) => {
    const type = recordSibling(state, path, 'assetType')
    if (type == null) return false
    return ['gift_cash', 'gift_equity', 'grant'].includes(type) ? true : 'n/a'
  },

  // --- REO ------------------------------------------------------------------
  reoIsRental: ({ state, path }) => {
    const occ = recordSibling(state, path, 'occupancy')
    if (occ == null) return false
    return occ === 'investment' ? true : 'n/a'
  },

  // --- Declarations ---------------------------------------------------------
  declaredBankruptcy: ({ state, path }) => {
    const p = pathIndices(path)[0]
    const v = val(state, `parties[${p}].declarations.declaredBankruptcy`)
    if (v == null) return false
    return v === true ? true : 'n/a'
  },
  // Any "yes" on the adverse-history declarations opens one written explanation task.
  declarationNeedsExplanation: ({ state, path }) => {
    const p = pathIndices(path)[0]
    const triggers = ['outstandingJudgments', 'delinquentFederalDebt', 'partyToLawsuit',
      'conveyedTitleInLieu', 'preForeclosureShortSale', 'propertyForeclosed', 'declaredBankruptcy']
    let anyUnknown = false
    for (const t of triggers) {
      const v = val(state, `parties[${p}].declarations.${t}`)
      if (v === true) return true
      if (v == null) anyUnknown = true
    }
    return anyUnknown ? false : 'n/a'
  },
})

// Count how many records exist in a repeating group for a party.
export function countGroup(state, partyIndex, group) {
  const prefix = `parties[${partyIndex}].${group}[`
  const seen = new Set()
  for (const p of Object.keys(state.fields || {})) {
    if (!p.startsWith(prefix)) continue
    const m = p.slice(prefix.length).match(/^(\d+)\]/)
    if (m) seen.add(Number(m[1]))
  }
  return seen.size
}

/**
 * Decide whether a conditionally-required field is required right now.
 * Returns true | false | 'n/a'. Unknown rule ids fail CLOSED (not required) and are surfaced
 * by the catalog contract test, so a typo can never silently make a field mandatory.
 */
export function evaluateRequirement(state, path) {
  const field = getField(path)
  if (!field) return false
  if (field.required) return true
  if (!field.requiredWhen) return false
  const rule = RULES[field.requiredWhen]
  if (!rule) return false
  return rule({ state, path })
}

// ── History coverage (§12: continue backward until the period is covered) ────
// Returns { coveredMonths, gaps, overlaps, sufficient, needsAnother, earliestStart }.
// `records` is an array of { index, start, end, isCurrent } with 'YYYY-MM' strings.
export function analyzeHistory(records, { requiredMonths, asOfMonth }) {
  const clean = (records || [])
    .filter((r) => r.start && monthToIndex(r.start) != null)
    .map((r) => ({
      ...r,
      startIdx: monthToIndex(r.start),
      endIdx: r.isCurrent ? monthToIndex(asOfMonth) : (r.end ? monthToIndex(r.end) : null),
    }))
    .sort((a, b) => a.startIdx - b.startIdx)

  const nowIdx = monthToIndex(asOfMonth)
  const windowStart = nowIdx - requiredMonths

  const gaps = []
  const overlaps = []
  let cursor = null

  for (const r of clean) {
    if (r.endIdx == null) continue // open-ended previous record — the planner asks for the end date
    if (cursor == null) { cursor = { start: r.startIdx, end: r.endIdx }; continue }
    if (r.startIdx > cursor.end + 1) {
      gaps.push({ fromIdx: cursor.end, toIdx: r.startIdx, months: r.startIdx - cursor.end })
    } else if (r.startIdx < cursor.end) {
      overlaps.push({ withIndex: r.index, months: cursor.end - r.startIdx })
    }
    cursor = { start: Math.min(cursor.start, r.startIdx), end: Math.max(cursor.end, r.endIdx) }
  }

  const earliestStart = clean.length ? Math.min(...clean.map((r) => r.startIdx)) : null
  const latestEnd = cursor ? cursor.end : null
  const coveredMonths = earliestStart != null && latestEnd != null ? latestEnd - earliestStart : 0

  // Sufficient when the earliest known start reaches back past the required window AND there
  // is no unexplained gap inside that window.
  const reachesBack = earliestStart != null && earliestStart <= windowStart
  const gapsInWindow = gaps.filter((g) => g.toIdx > windowStart)
  const sufficient = reachesBack && gapsInWindow.length === 0

  return {
    coveredMonths,
    gaps: gapsInWindow,
    overlaps,
    sufficient,
    needsAnother: !reachesBack,
    earliestStartIdx: earliestStart,
    requiredMonths,
  }
}

/** Convenience: months of history a single start→end pair covers. */
export function spanMonths(start, end) {
  const n = monthsBetween(start, end)
  return n == null ? null : Math.max(0, n)
}

export const RULES_META = Object.freeze({
  version: RULES_VERSION,
  ruleIds: Object.freeze(Object.keys(RULES)),
  requiredEmploymentHistoryMonths: REQUIRED_EMPLOYMENT_HISTORY_MONTHS,
  requiredResidenceHistoryMonths: REQUIRED_RESIDENCE_HISTORY_MONTHS,
})
