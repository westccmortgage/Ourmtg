// Autopilot Pre-Underwriting — is this document actually complete?
//
// Deterministic on purpose. "Is the February statement missing?" is arithmetic over statement
// months, not a judgement, and a model that agreed a file was complete when it wasn't would be
// the single most expensive failure this feature can have — the processor stops looking.
//
// So the model's only job upstream is to say what a document is and what it says. Whether that
// is enough is decided here, by rules, from the catalog.
//
// Every gap is phrased as something to send. That is what makes the output safe to show the
// borrower directly (docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md): asking for a document is a
// request, not a conclusion about the person.

import { getDocumentType } from './documentCatalog.js'
import { TAX_BUSINESS_RETURN_FOR_K1 } from './taxReturnContract.js'

const DAY = 86_400_000

/** YYYY-MM → comparable integer. */
const monthIndex = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''))
  if (!m) return null
  const year = Number(m[1]); const mon = Number(m[2])
  return mon >= 1 && mon <= 12 ? year * 12 + (mon - 1) : null
}

const parseDate = (d) => {
  const t = Date.parse(String(d || ''))
  return Number.isFinite(t) ? t : null
}

const daysBetween = (a, b) => Math.round((a - b) / DAY)

/**
 * Assess one document type against everything uploaded for it.
 *
 * @param {string} docKey
 * @param {Array<object>} parts   one entry per uploaded piece, already classified/extracted
 * @param {{asOf?: number}} [opts]
 * @returns {{complete: boolean, gaps: Array<{code: string, message: string}>}}
 *   `message` is borrower-safe: it names what to send, never what it would prove.
 */
export function assessCompleteness(docKey, parts, opts = {}) {
  const type = getDocumentType(docKey)
  if (!type) return { complete: false, gaps: [{ code: 'unknown_type', message: 'This document type isn’t recognized yet.' }] }

  const asOf = opts.asOf ?? Date.now()
  const items = Array.isArray(parts) ? parts.filter(Boolean) : []
  const rules = type.completeness || {}
  const gaps = []

  if (items.length === 0) {
    return { complete: false, gaps: [{ code: 'not_provided', message: `We still need your ${type.label.toLowerCase()}.` }] }
  }

  // ── Pages ────────────────────────────────────────────────────────────────
  // Statements are the usual offender: people photograph the page with the balance and skip the
  // rest, and the missing pages are exactly where the transactions live.
  if (rules.allPages) {
    for (const it of items) {
      const seen = Number(it.pagesPresent)
      const total = Number(it.pagesTotal)
      if (Number.isFinite(total) && Number.isFinite(seen) && seen < total) {
        gaps.push({
          code: 'missing_pages',
          message: `One upload has ${seen} of ${total} pages — please send the complete document, including pages that look blank.`,
        })
      }
    }
  }

  // ── Two-sided documents ──────────────────────────────────────────────────
  if (Array.isArray(rules.sides)) {
    const have = new Set(items.map((i) => String(i.side || '').toLowerCase()).filter(Boolean))
    const missing = rules.sides.filter((s) => !have.has(s))
    // Nothing said which side it is — treat a single upload as one side, not as both.
    if (have.size === 0 && items.length < rules.sides.length) {
      gaps.push({ code: 'missing_side', message: `Please send both the front and back of your ${type.label.toLowerCase()}.` })
    } else if (missing.length) {
      gaps.push({ code: 'missing_side', message: `We have the ${[...have].join(' and ')} — please also send the ${missing.join(' and ')}.` })
    }
  }

  // ── Expiry ───────────────────────────────────────────────────────────────
  if (rules.mustNotBeExpired) {
    for (const it of items) {
      const exp = parseDate(it.expirationDate)
      if (exp !== null && exp < asOf) {
        gaps.push({ code: 'expired', message: `Your ${type.label.toLowerCase()} has expired — please send a current one.` })
        break
      }
    }
  }

  if (rules.policyPeriodCoversToday) {
    const covered = items.some((it) => {
      const s = parseDate(it.policyStart); const e = parseDate(it.policyEnd)
      return s !== null && e !== null && s <= asOf && e >= asOf
    })
    if (!covered) {
      gaps.push({ code: 'policy_not_current', message: 'Please send the declaration page for the policy that’s active right now.' })
    }
  }

  // ── Recency ──────────────────────────────────────────────────────────────
  if (Number.isFinite(rules.freshWithinDays)) {
    const dates = items.map((i) => parseDate(i.documentDate ?? i.periodEnd ?? i.statementEnd)).filter((d) => d !== null)
    if (dates.length) {
      const newest = Math.max(...dates)
      const age = daysBetween(asOf, newest)
      if (age > rules.freshWithinDays) {
        gaps.push({
          code: 'stale',
          message: `The most recent one we have is ${age} days old — please send a newer ${type.label.toLowerCase()}.`,
        })
      }
    }
  }

  // ── Month coverage ───────────────────────────────────────────────────────
  if (Number.isFinite(rules.months)) {
    const months = [...new Set(items.map((i) => monthIndex(i.statementMonth)).filter((m) => m !== null))].sort((a, b) => a - b)
    if (months.length < rules.months) {
      gaps.push({
        code: 'missing_months',
        message: `We have ${months.length} of ${rules.months} months — please send the rest.`,
      })
    }
    if (rules.contiguous && months.length > 1) {
      // Name the actual holes. "Some months are missing" sends a borrower back through a year of
      // statements; "February and April" does not.
      const holes = []
      for (let i = 1; i < months.length; i += 1) {
        for (let m = months[i - 1] + 1; m < months[i]; m += 1) holes.push(m)
      }
      if (holes.length) {
        gaps.push({ code: 'gap_in_months', message: `Missing statement${holes.length > 1 ? 's' : ''} for ${holes.map(monthLabel).join(', ')}.` })
      }
    }
  }

  // ── Day coverage (pay stubs) ─────────────────────────────────────────────
  if (Number.isFinite(rules.coversDays)) {
    const spans = items
      .map((i) => ({ start: parseDate(i.payPeriodStart), end: parseDate(i.payPeriodEnd) }))
      .filter((s) => s.start !== null && s.end !== null && s.end >= s.start)
      .sort((a, b) => a.start - b.start)
    if (spans.length === 0) {
      gaps.push({ code: 'unreadable_period', message: `We couldn’t read the pay period — please send ${type.label.toLowerCase()} showing the dates covered.` })
    } else {
      const merged = mergeSpans(spans)
      const covered = merged.reduce((n, s) => n + daysBetween(s.end, s.start) + 1, 0)
      if (covered < rules.coversDays) {
        gaps.push({
          code: 'short_coverage',
          message: `These cover ${covered} days — please send enough pay stubs to cover ${rules.coversDays} days in a row.`,
        })
      } else if (rules.contiguous && merged.length > 1) {
        gaps.push({ code: 'gap_in_coverage', message: 'There’s a gap between pay periods — please send the stub that covers it.' })
      }
    }
  }

  // ── Tax years ────────────────────────────────────────────────────────────
  if (Number.isFinite(rules.taxYears)) {
    const years = [...new Set(items.flatMap((i) => [i.taxYear, ...(Array.isArray(i.taxYears) ? i.taxYears : [])])
      .map(Number).filter(Number.isInteger))].sort((a, b) => b - a)
    if (years.length < rules.taxYears) {
      gaps.push({ code: 'missing_tax_years', message: `We have ${years.length} of ${rules.taxYears} years — please send the other one.` })
    }
  }

  if (rules.taxPackage) {
    const forms = items.flatMap((i) => Array.isArray(i.taxForms) ? i.taxForms : [])
    const years = [...new Set(forms.map((f) => Number(f.taxYear)).filter(Number.isInteger))].sort((a, b) => b - a)
    if (forms.length === 0) {
      gaps.push({ code: 'unreadable_tax_package', message: 'We couldn’t identify the forms in this package — please send a complete, readable copy of the return.' })
    }
    for (const year of years) {
      if (!forms.some((f) => f.formType === '1040' && Number(f.taxYear) === year)) {
        gaps.push({ code: 'missing_form_1040', message: `The ${year} package is missing Form 1040 — please send the complete return.` })
      }
    }
    for (const k1 of forms.filter((f) => TAX_BUSINESS_RETURN_FOR_K1[f.formType])) {
      if (k1.ownershipPercent != null && Number(k1.ownershipPercent) < 25) continue
      const required = TAX_BUSINESS_RETURN_FOR_K1[k1.formType]
      const match = forms.some((f) => f.formType === required && Number(f.taxYear) === Number(k1.taxYear) && (
        !k1.entityName || !f.entityName || entitiesMatch(f.entityName, k1.entityName)
      ))
      if (!match) {
        gaps.push({
          code: 'missing_business_return',
          message: `The ${k1.taxYear} package needs the complete ${required.toUpperCase()} return${k1.entityName ? ` for ${k1.entityName}` : ''}.`,
        })
      }
    }
  }

  if (rules.mostRecentTaxYear && !items.some((i) => Number.isInteger(Number(i.taxYear)))) {
    gaps.push({ code: 'unreadable_tax_year', message: 'We couldn’t read which tax year this covers — please send the most recent bill.' })
  }

  // ── Credit ───────────────────────────────────────────────────────────────
  // A single-bureau report is not a tri-merge, and the middle score cannot be determined from
  // it. Reporting the file complete on one bureau would send it to underwriting to be returned.
  if (Number.isFinite(rules.bureaus)) {
    const seen = new Set()
    for (const it of items) {
      for (const b of asList(it.bureausIncluded)) seen.add(String(b).toLowerCase().replace(/[^a-z]/g, ''))
      // Fall back to the scores themselves — a report that lists three scores has three bureaus
      // whether or not it also prints a summary line naming them.
      if (it.equifaxScore != null) seen.add('equifax')
      if (it.experianScore != null) seen.add('experian')
      if (it.transUnionScore != null) seen.add('transunion')
    }
    if (seen.size < rules.bureaus) {
      gaps.push({
        code: 'not_tri_merge',
        message: `This report covers ${seen.size} of ${rules.bureaus} bureaus — a merged report from all three is needed.`,
      })
    }
  }

  // The substitute that arrives constantly and cannot be used: a consumer credit app. It is a
  // soft-pull educational score, not a repository-merged mortgage report, and accepting one
  // would put a number into qualification that no lender will honor.
  if (rules.mortgageGrade && items.some((i) => i.isConsumerReport === true)) {
    gaps.push({
      code: 'consumer_report',
      message: 'This is a consumer credit app report. Mortgage qualification needs a merged report pulled from the three repositories.',
    })
  }

  // ── Signatures ───────────────────────────────────────────────────────────
  if (rules.signedByAllParties) {
    const anyUnsigned = items.some((i) => i.signedByAllParties === false)
    if (anyUnsigned) {
      gaps.push({ code: 'unsigned', message: 'This copy isn’t signed by everyone — please send the fully signed version.' })
    }
  }

  return { complete: gaps.length === 0, gaps: dedupe(gaps) }
}

/**
 * Everything still needed across a file.
 *
 * @param {Array<{docKey: string, required?: boolean}>} checklist  what this loan needs
 * @param {Record<string, Array<object>>} byType  classified uploads keyed by docKey
 * @param {{asOf?: number, providedBy?: 'borrower'|'loan_team'}} [opts]
 *   `providedBy` filters to what that side can actually produce. Without it you get the whole
 *   list, which is right for a processor and wrong for a borrower: a credit report is required,
 *   missing, and impossible for them to send, so putting it on their list is asking someone to
 *   do something they cannot do and then waiting on them for it.
 * @returns {Array<{docKey, label, complete, gaps, providedBy}>} ordered as the checklist is
 */
export function missingForFile(checklist, byType, opts = {}) {
  return (Array.isArray(checklist) ? checklist : [])
    .map((item) => {
      const docKey = item?.docKey || item?.doc_key
      const type = getDocumentType(docKey)
      if (!type) return null
      const by = type.providedBy || 'borrower'
      if (opts.providedBy && by !== opts.providedBy) return null
      const { complete, gaps } = assessCompleteness(docKey, byType?.[docKey] || [], opts)
      return { docKey, label: type.label, complete, gaps, providedBy: by }
    })
    .filter((r) => r && !r.complete)
}

/**
 * How much of what this file needs is actually here. Team-facing: a readiness figure is a
 * conclusion about an application, so it stays inside (see the boundary doc).
 *
 * Counts documents, not gaps — one statement missing two months is one outstanding document, and
 * a percentage that moved because a gap was described more precisely would be meaningless.
 */
export function documentReadiness(checklist, byType, opts = {}) {
  const items = (Array.isArray(checklist) ? checklist : [])
    .map((i) => i?.docKey || i?.doc_key)
    .filter((k) => getDocumentType(k))
  if (items.length === 0) return { percent: 0, complete: 0, total: 0 }
  const complete = items.filter((k) => assessCompleteness(k, byType?.[k] || [], opts).complete).length
  return { percent: Math.round((complete / items.length) * 100), complete, total: items.length }
}

// ── helpers ────────────────────────────────────────────────────────────────

// bureausIncluded arrives as an array from a structured read, or as "Equifax, Experian,
// TransUnion" from a line of text. Both are the same fact.
const asList = (v) => {
  if (Array.isArray(v)) return v.filter(Boolean)
  if (typeof v === 'string') return v.split(/[,/;&]|\band\b/i).map((s) => s.trim()).filter(Boolean)
  return []
}

const normalizeEntity = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const entitiesMatch = (a, b) => {
  const x = normalizeEntity(a); const y = normalizeEntity(b)
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)))
}

function mergeSpans(sorted) {
  const out = [{ ...sorted[0] }]
  for (const s of sorted.slice(1)) {
    const last = out[out.length - 1]
    // Adjacent pay periods touch rather than overlap: one ends the day before the next starts,
    // and treating that as a gap would fail every borrower paid on a normal schedule.
    if (s.start <= last.end + DAY) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const monthLabel = (idx) => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`

const dedupe = (gaps) => {
  const seen = new Set()
  return gaps.filter((g) => (seen.has(g.message) ? false : (seen.add(g.message), true)))
}
