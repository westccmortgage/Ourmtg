// Autopilot Pre-Underwriting, Level 1 — deterministic tax-return income worksheet.
//
// The extraction model identifies forms and transcribes a closed set of lines. This module owns
// every treatment: source-form de-duplication, add-backs, ownership, two-year trend, and named
// missing inputs. It deliberately stops one step before "qualifying income". Tax-return cash
// flow still requires a licensed reviewer to confirm continuance, business access/stability and
// the applicable investor method. The output is a prepared, source-linked worksheet — never an
// approval, denial, eligibility result or final income decision.

import {
  TAX_BUSINESS_RETURN_FOR_K1, TAX_LINE_DEFINITIONS, TAX_RETURN_DOC_KEY,
} from './taxReturnContract.js'

export const TAX_INCOME_RULESET_VERSION = 'tax-income-1'
export const TAX_INCOME_NOT_MEANING = Object.freeze([
  'an approval or denial',
  'a final qualifying-income decision',
  'a Form 1084, Form 91, or investor worksheet signed by a reviewer',
])

const BUSINESS_RETURNS = new Set(['1120', '1120s', '1065'])
const CONTROLLING_1040 = Object.freeze({
  employment: 'form1040_wages',
  interest: 'form1040_taxable_interest',
  dividends: 'form1040_ordinary_dividends',
  retirement: ['form1040_ira_taxable', 'form1040_pensions_taxable', 'form1040_social_security_taxable'],
})

/**
 * Build the complete internal worksheet from live validated extractions.
 *
 * @param {Array<object>} extractions newest, non-superseded reads (other doc types are ignored)
 * @param {{asOf?: number}} [opts]
 */
export function analyzeTaxReturns(extractions = [], opts = {}) {
  const reads = (extractions || []).filter((e) => e?.docKey === TAX_RETURN_DOC_KEY && !e.supersededBy)
  if (reads.length === 0) return unavailable()

  const forms = reads.flatMap((e) => (e.taxForms || []).map((f) => ({ ...f, documentId: e.documentId })))
  const rawLines = reads.flatMap((e) => (e.taxLineItems || []).map((l) => ({ ...l, documentId: e.documentId })))
  const { lines, conflicts } = dedupeLines(rawLines)
  const yearsPresent = [...new Set(forms.map((f) => f.taxYear).filter(Number.isInteger))].sort((a, b) => a - b)
  const missing = completenessGaps(forms, lines, yearsPresent, opts.asOf ?? Date.now())
  const reviewFlags = []

  for (const c of conflicts) {
    missing.push({
      code: 'conflicting_line_values', year: c.taxYear, entity: c.entityName || c.propertyAddress || null,
      message: `${c.taxYear} ${TAX_LINE_DEFINITIONS[c.lineKey]?.label || c.lineKey} appears with conflicting amounts; choose the controlling return.`,
      evidence: c.evidence,
    })
  }

  const years = yearsPresent.map((taxYear) => analyzeYear({
    taxYear,
    forms: forms.filter((f) => f.taxYear === taxYear),
    lines: lines.filter((l) => l.taxYear === taxYear),
    conflicts: conflicts.filter((c) => c.taxYear === taxYear),
    reviewFlags,
    missing,
  }))

  const reconciliation = reconcile(lines)
  for (const r of reconciliation.filter((x) => x.status === 'discrepancy')) {
    reviewFlags.push({
      code: 'tax_reconciliation_difference', year: r.taxYear,
      message: `${r.label} differs by ${money(r.difference)} from its supporting forms.`,
      evidence: r.evidence,
    })
  }

  const excluded = lines
    .filter((l) => TAX_LINE_DEFINITIONS[l.lineKey]?.role === 'excluded')
    .map((l) => ({
      taxYear: l.taxYear,
      label: TAX_LINE_DEFINITIONS[l.lineKey].label,
      amount: l.amount,
      reason: 'Not included automatically; continuance and applicable investor treatment require review.',
      evidence: [lineEvidence(l)],
    }))
  if (excluded.length) {
    reviewFlags.push({
      code: 'variable_or_nonqualifying_income_excluded',
      message: `${excluded.length} variable or normally non-continuing tax item${excluded.length === 1 ? ' was' : 's were'} left out of the calculation.`,
      evidence: excluded.flatMap((x) => x.evidence),
    })
  }

  const comparison = compareYears(years)
  const uniqueMissing = dedupeMessages(missing)
  const uniqueFlags = dedupeMessages(reviewFlags)
  const prepared = comparison.calculatedAnnual !== null && uniqueMissing.length === 0

  return {
    version: TAX_INCOME_RULESET_VERSION,
    status: prepared ? 'prepared_for_review' : 'incomplete',
    meaning: prepared
      ? 'The tax-return arithmetic and two-year comparison are prepared for a licensed reviewer.'
      : 'The package was analyzed, but named inputs are still missing or conflicting.',
    notMeaning: [...TAX_INCOME_NOT_MEANING],
    humanReviewRequired: true,
    documentsRead: reads.length,
    formsRead: forms.length,
    lineItemsRead: lines.length,
    years,
    comparison,
    reconciliation,
    excluded,
    missing: uniqueMissing,
    reviewFlags: uniqueFlags,
    // This field is intentionally always null. The prepared calculation lives under comparison;
    // a future reviewer workflow may confirm/correct it, but extraction alone never qualifies it.
    qualifyingIncome: {
      annual: null,
      monthly: null,
      basis: 'Pending licensed human confirmation and applicable program/investor review.',
    },
  }
}

function unavailable() {
  return {
    version: TAX_INCOME_RULESET_VERSION,
    status: 'not_available',
    meaning: 'No complete tax-return package has been read.',
    notMeaning: [...TAX_INCOME_NOT_MEANING],
    humanReviewRequired: true,
    documentsRead: 0,
    formsRead: 0,
    lineItemsRead: 0,
    years: [],
    comparison: emptyComparison(),
    reconciliation: [],
    excluded: [],
    missing: [],
    reviewFlags: [],
    qualifyingIncome: { annual: null, monthly: null, basis: 'No tax-return package read.' },
  }
}

function completenessGaps(forms, lines, years, asOf) {
  const gaps = []
  if (forms.length === 0) {
    gaps.push({ code: 'no_supported_tax_forms', message: 'No supported tax forms were inventoried in the upload.' })
    return gaps
  }
  if (lines.length === 0) gaps.push({ code: 'no_supported_income_lines', message: 'No supported income lines were read from the package.' })
  if (years.length < 2) {
    gaps.push({ code: 'missing_second_tax_year', message: `Only ${years.length} tax year${years.length === 1 ? ' is' : 's are'} present; provide the second complete year.` })
  } else {
    const newestTwo = years.slice(-2)
    if (newestTwo[1] - newestTwo[0] !== 1) {
      gaps.push({ code: 'nonconsecutive_tax_years', message: `The two newest returns (${newestTwo.join(' and ')}) are not consecutive.` })
    }
  }
  for (const taxYear of years) {
    if (!forms.some((f) => f.taxYear === taxYear && f.formType === '1040')) {
      gaps.push({ code: 'missing_form_1040', year: taxYear, message: `${taxYear}: Form 1040 is missing from the package.` })
    }
  }

  const baseRequired = {
    schedule_c: ['schedulec_net_profit'],
    schedule_f: ['schedulef_net_profit'],
    '1120': ['form1120_taxable_income'],
    '1120s': ['form1120s_ordinary_income'],
    '1065': ['form1065_ordinary_income'],
    '8825': ['form8825_rental_income_loss'],
  }
  for (const form of forms) {
    const allSupported = Object.values(TAX_LINE_DEFINITIONS)
      .filter((d) => d.formTypes.includes(form.formType))
      .map((d) => d.key)
    const required = baseRequired[form.formType] || allSupported
    if (required.length === 0) continue
    const present = lines.some((l) => l.taxYear === form.taxYear && l.formType === form.formType && required.includes(l.lineKey) && (
      (!form.entityName && !form.propertyAddress) || sameEntity(l, form)
    ))
    if (!present) {
      gaps.push({
        code: 'missing_required_tax_line', year: form.taxYear, entity: form.entityName || form.propertyAddress || null,
        message: `${form.taxYear}: no supported ${form.formType.toUpperCase()} income${baseRequired[form.formType] ? ' base' : ''} line was read${form.entityName ? ` for ${form.entityName}` : ''}.`,
      })
    }
  }

  for (const source of forms.filter((f) => ['1099_nec', '1099_k'].includes(f.formType))) {
    if (!forms.some((f) => f.taxYear === source.taxYear && f.formType === 'schedule_c' && (
      sameEntity(f, source) || !source.entityName
    ))) {
      gaps.push({
        code: 'missing_self_employment_schedule', year: source.taxYear, entity: source.entityName || null,
        message: `${source.taxYear}: gross self-employment receipts are present without the expense schedule needed to calculate net income.`,
      })
    }
  }
  for (const source of forms.filter((f) => f.formType === '1099_misc')) {
    if (!forms.some((f) => f.taxYear === source.taxYear && ['schedule_c', 'schedule_e'].includes(f.formType))) {
      gaps.push({
        code: 'missing_income_expense_schedule', year: source.taxYear, entity: source.entityName || null,
        message: `${source.taxYear}: Form 1099-MISC is present without the schedule needed to determine net income and expenses.`,
      })
    }
  }

  // A K-1 holder at 25% or more is self-employed for this analysis. Unknown ownership fails
  // closed because interpreting an absent percentage as below 25% would waive the business return.
  for (const k1 of forms.filter((f) => TAX_BUSINESS_RETURN_FOR_K1[f.formType])) {
    const requiredReturn = TAX_BUSINESS_RETURN_FOR_K1[k1.formType]
    if (k1.ownershipPercent != null && k1.ownershipPercent < 25) continue
    if (!matchingEntityForm(forms, k1, requiredReturn)) {
      gaps.push({
        code: 'missing_business_return', year: k1.taxYear, entity: k1.entityName || null,
        message: `${k1.taxYear}: ${requiredReturn.toUpperCase()} return is missing for ${k1.entityName || 'the K-1 entity'}.`,
      })
    }
    const hasRental = lines.some((l) => l.taxYear === k1.taxYear && [
      'k1_net_rental_real_estate', 'k1_other_rental_income',
    ].includes(l.lineKey) && sameEntity(l, k1))
    if (hasRental && !matchingEntityForm(forms, k1, '8825')) {
      gaps.push({
        code: 'missing_form_8825', year: k1.taxYear, entity: k1.entityName || null,
        message: `${k1.taxYear}: Form 8825 is missing for rental income from ${k1.entityName || 'the K-1 entity'}.`,
      })
    }
  }

  for (const business of forms.filter((f) => BUSINESS_RETURNS.has(f.formType))) {
    const pct = ownershipFor(forms, business)
    if (pct === null) {
      gaps.push({
        code: 'missing_ownership_percent', year: business.taxYear, entity: business.entityName || null,
        message: `${business.taxYear}: ownership percentage is missing for ${business.entityName || business.formType.toUpperCase()}.`,
      })
    }
  }

  // We do not assume the latest legally required filing year because extensions and investor
  // overlays exist. We do surface obviously stale packages as a question, not a rejection.
  const currentYear = new Date(asOf).getUTCFullYear()
  const latest = years.at(-1)
  if (latest != null && latest < currentYear - 2) {
    gaps.push({ code: 'stale_tax_years', year: latest, message: `The newest return is ${latest}; confirm whether a more recent filed return or extension is required.` })
  }
  return gaps
}

function analyzeYear({ taxYear, forms, lines, conflicts, reviewFlags, missing }) {
  const selected = lines.map((line) => ({ line, inclusion: inclusionFor(line, lines, forms) }))
  const sources = new Map()
  for (const row of selected) {
    const definition = TAX_LINE_DEFINITIONS[row.line.lineKey]
    const key = sourceKey(row.line, definition)
    const source = sources.get(key) || newSource(key, row.line, definition)
    source.formTypes.add(row.line.formType)
    source.evidence.push(lineEvidence(row.line))

    if (!row.inclusion.include) {
      source.crossChecks.push({
        lineKey: row.line.lineKey, label: definition.label, amount: row.line.amount,
        reason: row.inclusion.reason, evidence: [lineEvidence(row.line)],
      })
      sources.set(key, source)
      continue
    }

    if (definition.role === 'addback') {
      if (row.line.amount < 0) {
        source.unresolved = true
        missing.push({
          code: 'negative_addback', year: taxYear, entity: source.label,
          message: `${taxYear}: ${definition.label} is negative; a reviewer must determine its treatment.`,
          evidence: [lineEvidence(row.line)],
        })
      } else {
        source.adjustments.push({
          lineKey: row.line.lineKey, label: definition.label, amount: row.line.amount,
          evidence: [lineEvidence(row.line)],
        })
      }
    } else {
      source.base.push({
        lineKey: row.line.lineKey, label: definition.label, amount: row.line.amount,
        evidence: [lineEvidence(row.line)],
      })
    }
    if (row.inclusion.provisional) source.provisional = true
    sources.set(key, source)
  }

  const out = [...sources.values()].map((source) => finishSource(source, forms, reviewFlags, missing, taxYear))
  const contributing = out.filter((s) => s.includedLineCount > 0)
  const unresolved = contributing.some((s) => s.annual === null) || conflicts.length > 0
  const knownAnnual = round2(contributing.reduce((sum, s) => sum + (s.annual ?? 0), 0))
  const calculatedAnnual = contributing.length > 0 && !unresolved ? knownAnnual : null
  return {
    taxYear,
    status: calculatedAnnual === null ? 'incomplete' : 'calculated_pending_review',
    knownAnnual,
    knownMonthly: round2(knownAnnual / 12),
    calculatedAnnual,
    calculatedMonthly: calculatedAnnual === null ? null : round2(calculatedAnnual / 12),
    forms: forms.map(formEvidence).sort((a, b) => a.pageStart - b.pageStart),
    sources: out.sort((a, b) => a.label.localeCompare(b.label)),
  }
}

function newSource(id, line, definition) {
  return {
    id,
    label: sourceLabel(line, definition),
    kind: sourceKind(line, definition),
    entityName: line.entityName || null,
    taxpayerName: line.taxpayerName || null,
    propertyAddress: line.propertyAddress || null,
    formTypes: new Set(),
    base: [], adjustments: [], crossChecks: [], evidence: [],
    unresolved: false, provisional: false,
  }
}

function finishSource(source, forms, reviewFlags, missing, taxYear) {
  const baseTotal = round2(source.base.reduce((sum, x) => sum + x.amount, 0))
  const adjustmentsTotal = round2(source.adjustments.reduce((sum, x) => sum + x.amount, 0))
  const includedLineCount = source.base.length + source.adjustments.length
  if (source.adjustments.length && source.base.length === 0) source.unresolved = true
  if (source.provisional) source.unresolved = true

  const hasBusinessReturn = [...source.formTypes].some((f) => BUSINESS_RETURNS.has(f))
  let ownershipPercent = 100
  if (hasBusinessReturn) {
    const probe = {
      taxYear,
      formType: [...source.formTypes].find((f) => BUSINESS_RETURNS.has(f)),
      entityName: source.entityName,
    }
    ownershipPercent = ownershipFor(forms, probe)
    if (ownershipPercent === null) source.unresolved = true
  }

  const entityAnnual = includedLineCount ? round2(baseTotal + adjustmentsTotal) : null
  const annual = source.unresolved || entityAnnual === null || ownershipPercent === null
    ? null
    : round2(entityAnnual * (ownershipPercent / 100))
  const minConfidence = source.evidence.length
    ? Math.min(...source.evidence.map((e) => e.confidence).filter((c) => typeof c === 'number'))
    : null

  if (minConfidence !== null && minConfidence < 0.75) {
    reviewFlags.push({
      code: 'low_confidence_tax_value', year: taxYear, entity: source.label,
      message: `${taxYear}: ${source.label} contains a low-confidence reading.`,
      evidence: source.evidence.filter((e) => e.confidence === minConfidence),
    })
  }
  if (source.provisional) {
    reviewFlags.push({
      code: 'k1_without_controlling_return', year: taxYear, entity: source.entityName,
      message: `${taxYear}: ${source.label} is present without its controlling business return, so the source remains unresolved.`,
      evidence: source.evidence,
    })
  }
  if (hasBusinessReturn) {
    reviewFlags.push({
      code: 'business_cash_flow_review', year: taxYear, entity: source.entityName,
      message: `${taxYear}: confirm business stability, liquidity and the borrower's access to ${source.label} cash flow.`,
      evidence: source.evidence,
    })
  }
  if (source.kind === 'rental') {
    reviewFlags.push({
      code: 'rental_income_review', year: taxYear, entity: source.propertyAddress || source.entityName,
      message: `${taxYear}: confirm property ownership, current housing expense and applicable rental-income treatment for ${source.label}.`,
      evidence: source.evidence,
    })
  }
  if (source.adjustments.length && source.base.length === 0) {
    missing.push({
      code: 'missing_source_base', year: taxYear, entity: source.label,
      message: `${taxYear}: ${source.label} has add-backs but no supported base income line.`,
      evidence: source.evidence,
    })
  }

  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    entityName: source.entityName,
    taxpayerName: source.taxpayerName,
    propertyAddress: source.propertyAddress,
    formTypes: [...source.formTypes].sort(),
    base: source.base,
    baseTotal,
    adjustments: source.adjustments,
    adjustmentsTotal,
    crossChecks: source.crossChecks,
    entityAnnual,
    ownershipPercent,
    annual,
    monthly: annual === null ? null : round2(annual / 12),
    includedLineCount,
    minConfidence,
    evidence: source.evidence,
  }
}

function inclusionFor(line, lines, forms) {
  const def = TAX_LINE_DEFINITIONS[line.lineKey]
  if (!def || ['reconciliation', 'informational', 'excluded'].includes(def.role)) {
    return { include: false, reason: def?.role || 'unsupported' }
  }
  if (def.role !== 'fallback') return { include: true }

  const control = CONTROLLING_1040[def.group]
  const controls = Array.isArray(control) ? control : [control].filter(Boolean)
  if (controls.some((key) => lines.some((x) => x.taxYear === line.taxYear && x.lineKey === key))) {
    return { include: false, reason: 'represented_on_form_1040' }
  }
  if (line.formType === '1099_nec' && lines.some((x) => x.taxYear === line.taxYear && x.formType === 'schedule_c' && sameEntity(x, line))) {
    return { include: false, reason: 'represented_on_schedule_c' }
  }
  if (line.formType === '1099_misc' && lines.some((x) => x.taxYear === line.taxYear && x.formType === 'schedule_e' && sameEntity(x, line))) {
    return { include: false, reason: 'represented_on_schedule_e' }
  }
  if (line.formType.startsWith('k1_')) {
    const returnType = TAX_BUSINESS_RETURN_FOR_K1[line.formType]
    const controllingLine = {
      k1_ordinary_business_income: returnType === '1120s' ? 'form1120s_ordinary_income' : 'form1065_ordinary_income',
      k1_net_rental_real_estate: 'form8825_rental_income_loss',
      k1_other_rental_income: 'form8825_rental_income_loss',
    }[line.lineKey]
    if (controllingLine && lines.some((x) => x.taxYear === line.taxYear && x.lineKey === controllingLine && sameEntity(x, line))) {
      return { include: false, reason: `represented_on_${controllingLine.startsWith('form8825') ? '8825' : returnType}` }
    }
    const k1 = forms.find((f) => f.taxYear === line.taxYear && f.formType === line.formType && (
      sameEntity(f, line) || (!f.entityName && !line.entityName)
    ))
    // Below 25%, the K-1 amount is already the taxpayer's share and the entity return is not
    // automatically required by this worksheet. Unknown ownership fails closed.
    return { include: true, provisional: k1?.ownershipPercent == null || k1.ownershipPercent >= 25 }
  }
  return { include: true }
}

function sourceKey(line, definition) {
  const person = normalize(line.taxpayerName) || 'taxpayer'
  const entity = normalize(line.entityName)
  const property = normalize(line.propertyAddress)
  // Every K-1 amount is already the taxpayer's share. Keep it out of the entity source, whose
  // total is multiplied by ownership, or guaranteed payments/portfolio income get haircut twice.
  if (line.formType.startsWith('k1_')) {
    return `${line.taxYear}|k1-share|${entity || person}|${definition.group}`
  }
  if (BUSINESS_RETURNS.has(line.formType) || line.formType === '8825') {
    return `${line.taxYear}|entity|${entity || property || person}`
  }
  if (line.formType === 'schedule_c') return `${line.taxYear}|schedule-c|${entity || person}`
  if (line.formType === 'schedule_f') return `${line.taxYear}|farm|${entity || person}`
  if (line.formType === 'schedule_e' && definition.group === 'rental') return `${line.taxYear}|rental|${property || entity || person}`
  if (line.formType === '1099_nec') return `${line.taxYear}|schedule-c|${entity || person}`
  if (definition.group === 'rental') return `${line.taxYear}|rental|${property || entity || person}`
  return `${line.taxYear}|${person}|${definition.group}`
}

function sourceKind(line, definition) {
  if (line.formType.startsWith('k1_')) return definition.group === 'business' ? 'business' : definition.group
  if (BUSINESS_RETURNS.has(line.formType) || line.formType === 'schedule_c') return 'business'
  if (line.formType === 'schedule_f') return 'farm'
  return definition.group
}

function sourceLabel(line, definition) {
  if (line.propertyAddress) return `Rental — ${line.propertyAddress}`
  if (line.formType.startsWith('k1_')) return `K-1 — ${line.entityName || definition.label}`
  if (line.entityName) return line.entityName
  return {
    employment: 'Wages', interest: 'Interest', dividends: 'Dividends', retirement: 'Retirement / Social Security',
    rental: 'Rental income', royalties: 'Royalties', farm: 'Farm income', business: 'Business income',
  }[definition.group] || definition.label
}

function ownershipFor(forms, item) {
  const candidates = forms.filter((f) => f.taxYear === item.taxYear && (
    sameEntity(f, item) || (!f.entityName && !item.entityName)
  ) && (BUSINESS_RETURNS.has(f.formType) || f.formType.startsWith('k1_')))
  const values = [...new Set(candidates.map((f) => f.ownershipPercent).filter((n) => typeof n === 'number'))]
  return values.length === 1 ? values[0] : null
}

function matchingEntityForm(forms, item, formType) {
  const exact = forms.filter((f) => f.taxYear === item.taxYear && f.formType === formType)
  if (!item.entityName) return exact.length === 1 ? exact[0] : null
  return exact.find((f) => sameEntity(f, item)) || null
}

function sameEntity(a, b) {
  const ae = normalize(a?.entityName || a?.propertyAddress)
  const be = normalize(b?.entityName || b?.propertyAddress)
  if (!ae || !be) return false
  return ae === be || ae.includes(be) || be.includes(ae)
}

function dedupeLines(raw) {
  const byKey = new Map()
  const conflicts = new Map()
  for (const line of raw) {
    const key = [line.taxYear, line.lineKey, normalize(line.taxpayerName), normalize(line.entityName), normalize(line.propertyAddress)].join('|')
    if (conflicts.has(key)) {
      conflicts.get(key).evidence.push(lineEvidence(line))
      continue
    }
    const prior = byKey.get(key)
    if (!prior) { byKey.set(key, line); continue }
    if (Math.abs(prior.amount - line.amount) > 0.01) {
      conflicts.set(key, {
        taxYear: line.taxYear, lineKey: line.lineKey, entityName: line.entityName,
        propertyAddress: line.propertyAddress, evidence: [lineEvidence(prior), lineEvidence(line)],
      })
      byKey.delete(key)
      continue
    }
    if ((line.confidence ?? 0) > (prior.confidence ?? 0)) byKey.set(key, line)
  }
  return { lines: [...byKey.values()], conflicts: [...conflicts.values()] }
}

function reconcile(lines) {
  const out = []
  for (const taxYear of [...new Set(lines.map((l) => l.taxYear))].sort()) {
    addReconciliation(out, lines, taxYear, 'form1040_wages', ['w2_wages'], '1040 wages ↔ W-2 forms')
    addReconciliation(out, lines, taxYear, 'form1040_taxable_interest', ['form1099_interest', 'k1_interest_income'], '1040 taxable interest ↔ source forms')
    addReconciliation(out, lines, taxYear, 'form1040_ordinary_dividends', ['form1099_dividends', 'k1_ordinary_dividends'], '1040 ordinary dividends ↔ source forms')
    addReconciliation(out, lines, taxYear, 'schedule1_business_income', ['schedulec_net_profit'], 'Schedule 1 business income ↔ Schedule C')
  }
  return out
}

function addReconciliation(out, lines, taxYear, controlKey, supportKeys, label) {
  const control = lines.find((l) => l.taxYear === taxYear && l.lineKey === controlKey)
  const supports = lines.filter((l) => l.taxYear === taxYear && supportKeys.includes(l.lineKey))
  if (!control || supports.length === 0) return
  const supportingAmount = round2(supports.reduce((sum, l) => sum + l.amount, 0))
  const difference = round2(control.amount - supportingAmount)
  out.push({
    taxYear, label, reportedAmount: control.amount, supportingAmount, difference,
    status: Math.abs(difference) <= 1 ? 'matched' : 'discrepancy',
    evidence: [lineEvidence(control), ...supports.map(lineEvidence)],
  })
}

function compareYears(years) {
  // Never hop over an incomplete newest return and average two older, convenient years. The
  // current trend is unknowable until the current input is resolved.
  const newestTwo = [...years].sort((a, b) => a.taxYear - b.taxYear).slice(-2)
  if (newestTwo.length < 2 || newestTwo.some((y) => y.calculatedAnnual === null)) return emptyComparison()
  const [older, newer] = newestTwo
  const change = round2(newer.calculatedAnnual - older.calculatedAnnual)
  const changePercent = older.calculatedAnnual === 0 ? null : round2((change / Math.abs(older.calculatedAnnual)) * 100)
  const trend = changePercent === null ? 'not_computable' : (changePercent < -5 ? 'declining' : (changePercent > 5 ? 'increasing' : 'stable'))
  const calculatedAnnual = trend === 'declining'
    ? newer.calculatedAnnual
    : round2((older.calculatedAnnual + newer.calculatedAnnual) / 2)
  return {
    years: [older.taxYear, newer.taxYear],
    olderAnnual: older.calculatedAnnual,
    newerAnnual: newer.calculatedAnnual,
    change,
    changePercent,
    trend,
    method: trend === 'declining' ? 'most recent year because income declined' : 'two-year average',
    calculatedAnnual,
    calculatedMonthly: round2(calculatedAnnual / 12),
  }
}

function emptyComparison() {
  return {
    years: [], olderAnnual: null, newerAnnual: null, change: null, changePercent: null,
    trend: 'not_computable', method: null, calculatedAnnual: null, calculatedMonthly: null,
  }
}

function lineEvidence(line) {
  return {
    documentId: line.documentId || null,
    formType: line.formType,
    taxYear: line.taxYear,
    page: line.page,
    lineKey: line.lineKey,
    lineLabel: line.lineLabel,
    amount: line.amount,
    confidence: line.confidence,
    rawText: line.rawText || null,
  }
}

function formEvidence(form) {
  return {
    documentId: form.documentId || null,
    formType: form.formType,
    taxYear: form.taxYear,
    taxpayerName: form.taxpayerName || null,
    entityName: form.entityName || null,
    propertyAddress: form.propertyAddress || null,
    ownershipPercent: form.ownershipPercent ?? null,
    pageStart: form.pageStart,
    pageEnd: form.pageEnd ?? form.pageStart,
    confidence: form.confidence,
  }
}

function dedupeMessages(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = [item.code, item.year || '', normalize(item.entity), item.message].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const normalize = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')
const round2 = (n) => Math.round(n * 100) / 100
const money = (n) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}${n < 0 ? ' (supporting forms higher)' : ''}`
