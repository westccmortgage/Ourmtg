// Autopilot Pre-Underwriting — the closed vocabulary for federal tax-return reads.
//
// A complete return is not one flat document. It is a package of forms whose lines have very
// different meanings: Schedule C net profit is a starting point, depreciation may be an
// add-back, Schedule 1 is mostly a reconciliation total, and a K-1 can duplicate the business
// return that supports it. The model is allowed to identify forms and transcribe these named
// lines. It is never allowed to choose the treatment. TAX_LINE_DEFINITIONS is the deterministic
// hand-off to taxIncome.js and is intentionally a closed list.

import { looksLikeInjection, redactSensitive } from '../conversational-1003/turnContract.js'

export const TAX_RETURN_DOC_KEY = 'tax_return_full'
export const MAX_TAX_FORMS = 100
export const MAX_TAX_LINE_ITEMS = 300
export const MAX_TAX_TEXT = 240

export const TAX_FORM_TYPES = Object.freeze([
  '1040', 'schedule_1', 'schedule_b', 'schedule_c', 'schedule_d', 'schedule_e',
  'schedule_f', 'w2', '1099_int', '1099_div', '1099_nec', '1099_misc', '1099_k',
  '1099_r', 'ssa_1099', 'k1_1120s', 'k1_1065', 'k1_1041', '1120', '1120s',
  '1065', '8825', '4562',
])
export const TAX_BUSINESS_RETURN_FOR_K1 = Object.freeze({ k1_1120s: '1120s', k1_1065: '1065' })

// role is arithmetic, not prose from the model:
//   base           signed amount starts or adds to a source
//   addback        a positive non-cash expense is added back
//   reconciliation cross-check only; already represented by detailed schedules
//   fallback       used only when the controlling return/schedule is absent
//   excluded       visible in the report but never silently treated as stable income
//   informational  evidence for review, never arithmetic
const lines = {
  // Individual return. Aggregated lines control over the source forms to prevent W-2/1099
  // double counting when the package contains both.
  form1040_wages:                    ['1040', 'Wages, salaries, tips', 'base', 'employment'],
  form1040_taxable_interest:         ['1040', 'Taxable interest', 'base', 'interest'],
  form1040_ordinary_dividends:       ['1040', 'Ordinary dividends', 'base', 'dividends'],
  form1040_ira_taxable:              ['1040', 'Taxable IRA distributions', 'base', 'retirement'],
  form1040_pensions_taxable:         ['1040', 'Taxable pensions and annuities', 'base', 'retirement'],
  form1040_social_security_taxable:  ['1040', 'Taxable Social Security benefits', 'base', 'retirement'],
  form1040_capital_gain:             ['1040', 'Capital gain or loss', 'excluded', 'capital_gains'],
  form1040_other_income:             ['1040', 'Schedule 1 additional income', 'reconciliation', 'other'],
  form1040_total_income:             ['1040', 'Total income', 'reconciliation', 'total'],
  form1040_adjusted_gross_income:    ['1040', 'Adjusted gross income', 'reconciliation', 'total'],

  schedule1_business_income:         ['schedule_1', 'Business income or loss', 'reconciliation', 'business'],
  schedule1_rental_partnership:      ['schedule_1', 'Rental, royalty, partnership, S corporation income or loss', 'reconciliation', 'rental'],
  schedule1_farm_income:             ['schedule_1', 'Farm income or loss', 'reconciliation', 'farm'],
  schedule1_unemployment:            ['schedule_1', 'Unemployment compensation', 'excluded', 'other'],
  schedule1_other_income:            ['schedule_1', 'Other income', 'excluded', 'other'],

  schedulec_net_profit:              ['schedule_c', 'Net profit or loss', 'base', 'business'],
  schedulec_depreciation:            ['schedule_c', 'Depreciation', 'addback', 'business'],
  schedulec_depletion:               ['schedule_c', 'Depletion', 'addback', 'business'],
  schedulec_business_use_home:       ['schedule_c', 'Business use of home', 'addback', 'business'],
  schedulec_amortization:            ['schedule_c', 'Amortization included in other expenses', 'addback', 'business'],

  scheduled_net_capital_gain:        ['schedule_d', 'Net capital gain or loss', 'excluded', 'capital_gains'],

  schedulee_rental_income_loss:      ['schedule_e', 'Rental real-estate income or loss', 'base', 'rental'],
  schedulee_rental_depreciation:     ['schedule_e', 'Rental depreciation', 'addback', 'rental'],
  schedulee_royalty_income_loss:     ['schedule_e', 'Royalty income or loss', 'base', 'royalties'],
  schedulee_k1_income_loss:          ['schedule_e', 'Partnership or S corporation income or loss', 'reconciliation', 'business'],

  schedulef_net_profit:              ['schedule_f', 'Farm net profit or loss', 'base', 'farm'],
  schedulef_depreciation:            ['schedule_f', 'Farm depreciation', 'addback', 'farm'],
  schedulef_depletion:               ['schedule_f', 'Farm depletion', 'addback', 'farm'],

  // Source forms are fallbacks/cross-checks when the controlling 1040 line or business
  // schedule is present. They remain valuable evidence in the report.
  w2_wages:                          ['w2', 'W-2 wages, tips and other compensation', 'fallback', 'employment'],
  form1099_interest:                 ['1099_int', '1099 interest income', 'fallback', 'interest'],
  form1099_dividends:                ['1099_div', '1099 ordinary dividends', 'fallback', 'dividends'],
  // Gross receipts are not net qualifying income. Without the expense schedule, using them is
  // the tax-return version of Number('') === 0: plausible, easy and wrong.
  form1099_nec_compensation:         ['1099_nec', '1099 nonemployee compensation', 'informational', 'business'],
  form1099_misc_rents:               ['1099_misc', '1099 rents', 'informational', 'rental'],
  form1099_misc_royalties:           ['1099_misc', '1099 royalties', 'informational', 'royalties'],
  form1099k_gross_payments:          ['1099_k', '1099-K gross payments', 'informational', 'business'],
  form1099r_taxable_amount:          ['1099_r', '1099-R taxable amount', 'fallback', 'retirement'],
  ssa1099_net_benefits:              ['ssa_1099', 'Social Security net benefits', 'fallback', 'retirement'],

  // K-1 amounts are already the taxpayer's share. Ordinary/rental amounts are fallbacks when
  // the matching entity return is absent; guaranteed payments are separately received income.
  k1_ordinary_business_income:       [['k1_1120s', 'k1_1065'], 'K-1 ordinary business income or loss', 'fallback', 'business'],
  k1_net_rental_real_estate:         [['k1_1120s', 'k1_1065'], 'K-1 net rental real-estate income or loss', 'fallback', 'rental'],
  k1_other_rental_income:            [['k1_1120s', 'k1_1065'], 'K-1 other rental income or loss', 'fallback', 'rental'],
  k1_guaranteed_payments:            ['k1_1065', 'K-1 guaranteed payments', 'base', 'business'],
  k1_interest_income:                [['k1_1120s', 'k1_1065', 'k1_1041'], 'K-1 interest income', 'fallback', 'interest'],
  k1_ordinary_dividends:             [['k1_1120s', 'k1_1065', 'k1_1041'], 'K-1 ordinary dividends', 'fallback', 'dividends'],
  k1_royalties:                      [['k1_1120s', 'k1_1065', 'k1_1041'], 'K-1 royalties', 'base', 'royalties'],
  k1_capital_gain:                   [['k1_1120s', 'k1_1065', 'k1_1041'], 'K-1 capital gain or loss', 'excluded', 'capital_gains'],
  k1_section179:                     [['k1_1120s', 'k1_1065'], 'K-1 Section 179 deduction', 'informational', 'business'],
  k1_distributions:                  [['k1_1120s', 'k1_1065'], 'K-1 distributions', 'informational', 'business'],

  // Business-return cash flow. Availability to the borrower and business stability are human
  // review questions; the arithmetic here only prepares the worksheet.
  form1120s_ordinary_income:         ['1120s', 'S corporation ordinary income or loss', 'base', 'business'],
  form1120s_depreciation:            ['1120s', 'S corporation depreciation', 'addback', 'business'],
  form1120s_depletion:               ['1120s', 'S corporation depletion', 'addback', 'business'],
  form1120s_amortization:            ['1120s', 'S corporation amortization', 'addback', 'business'],
  form1120s_officer_compensation:    ['1120s', 'Compensation of officers', 'reconciliation', 'employment'],
  form1120s_distributions:           ['1120s', 'Shareholder distributions', 'informational', 'business'],
  form1120s_total_assets:            ['1120s', 'Total assets', 'informational', 'business'],

  form1065_ordinary_income:          ['1065', 'Partnership ordinary income or loss', 'base', 'business'],
  form1065_depreciation:             ['1065', 'Partnership depreciation', 'addback', 'business'],
  form1065_depletion:                ['1065', 'Partnership depletion', 'addback', 'business'],
  form1065_amortization:             ['1065', 'Partnership amortization', 'addback', 'business'],
  form1065_guaranteed_payments:      ['1065', 'Partnership guaranteed payments total', 'reconciliation', 'business'],
  form1065_distributions:            ['1065', 'Partnership distributions', 'informational', 'business'],
  form1065_total_assets:             ['1065', 'Partnership total assets', 'informational', 'business'],

  form1120_taxable_income:           ['1120', 'C corporation taxable income before special deductions', 'base', 'business'],
  form1120_depreciation:             ['1120', 'C corporation depreciation', 'addback', 'business'],
  form1120_depletion:                ['1120', 'C corporation depletion', 'addback', 'business'],
  form1120_amortization:             ['1120', 'C corporation amortization', 'addback', 'business'],
  form1120_officer_compensation:     ['1120', 'Compensation of officers', 'reconciliation', 'employment'],
  form1120_total_assets:             ['1120', 'C corporation total assets', 'informational', 'business'],

  form8825_rental_income_loss:       ['8825', 'Entity rental real-estate income or loss', 'base', 'rental'],
  form8825_depreciation:             ['8825', 'Entity rental depreciation', 'addback', 'rental'],
  form4562_depreciation:             ['4562', 'Depreciation and amortization detail', 'reconciliation', 'business'],
}

export const TAX_LINE_DEFINITIONS = Object.freeze(Object.fromEntries(
  Object.entries(lines).map(([key, [forms, label, role, group]]) => [key, Object.freeze({
    key, formTypes: Object.freeze(Array.isArray(forms) ? forms : [forms]), label, role, group,
  })]),
))
export const TAX_LINE_KEYS = Object.freeze(Object.keys(TAX_LINE_DEFINITIONS))

const SSN_LIKE = /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/
const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const safeText = (v, max = MAX_TAX_TEXT) => {
  const value = v == null ? '' : String(v).slice(0, max).trim()
  if (!value || SSN_LIKE.test(value) || looksLikeInjection(value)) return null
  return redactSensitive(value).text || null
}
const confidence = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
  }
  return null
}
const year = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN)
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null
}
const positiveInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN)
  return Number.isInteger(n) && n > 0 ? n : null
}
const amount = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-')
  const n = Number(s.replace(/[()$,\s-]/g, ''))
  return Number.isFinite(n) ? (negative ? -n : n) : null
}
const normalized = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')

/**
 * Validate the two tax-only arrays on a provider response.
 *
 * @returns {{forms: object[], lineItems: object[], rejected: object[], confidences: number[]}}
 */
export function validateTaxReturnData(raw, docKey) {
  const rejected = []
  const forms = []
  const lineItems = []
  const rawForms = Array.isArray(raw?.taxForms) ? raw.taxForms.slice(0, MAX_TAX_FORMS) : []
  const rawLines = Array.isArray(raw?.taxLineItems) ? raw.taxLineItems.slice(0, MAX_TAX_LINE_ITEMS) : []

  if (Array.isArray(raw?.taxForms) && raw.taxForms.length > MAX_TAX_FORMS) {
    rejected.push({ field: 'taxForms', reason: 'too_many_tax_forms' })
  }
  if (Array.isArray(raw?.taxLineItems) && raw.taxLineItems.length > MAX_TAX_LINE_ITEMS) {
    rejected.push({ field: 'taxLineItems', reason: 'too_many_tax_line_items' })
  }
  if (docKey !== TAX_RETURN_DOC_KEY) {
    if (rawForms.length) rejected.push({ field: 'taxForms', reason: 'tax_data_not_on_this_type' })
    if (rawLines.length) rejected.push({ field: 'taxLineItems', reason: 'tax_data_not_on_this_type' })
    return { forms, lineItems, rejected, confidences: [] }
  }

  const seenForms = new Set()
  for (const item of rawForms) {
    const v = validateForm(item)
    if (!v.ok) { rejected.push({ field: 'taxForms', reason: v.reason }); continue }
    const signature = formSignature(v.value)
    if (seenForms.has(signature)) { rejected.push({ field: 'taxForms', reason: 'duplicate_tax_form' }); continue }
    seenForms.add(signature)
    forms.push(v.value)
  }

  const seenLines = new Set()
  for (const item of rawLines) {
    const v = validateLine(item)
    if (!v.ok) { rejected.push({ field: 'taxLineItems', reason: v.reason }); continue }
    if (!forms.some((f) => f.formType === v.value.formType && f.taxYear === v.value.taxYear)) {
      rejected.push({ field: v.value.lineKey, reason: 'form_not_in_inventory' })
      continue
    }
    const signature = lineSignature(v.value)
    if (seenLines.has(signature)) { rejected.push({ field: v.value.lineKey, reason: 'duplicate_tax_line' }); continue }
    seenLines.add(signature)
    lineItems.push(v.value)
  }

  return {
    forms,
    lineItems,
    rejected,
    confidences: [...forms.map((f) => f.confidence), ...lineItems.map((l) => l.confidence)],
  }
}

function validateForm(item) {
  if (!plain(item)) return { ok: false, reason: 'not_an_object' }
  const formType = TAX_FORM_TYPES.includes(item.formType) ? item.formType : null
  if (!formType) return { ok: false, reason: 'unknown_tax_form' }
  const taxYear = year(item.taxYear)
  if (taxYear === null) return { ok: false, reason: 'invalid_tax_year' }
  const pageStart = positiveInt(item.pageStart)
  if (pageStart === null) return { ok: false, reason: 'missing_form_page' }
  const c = confidence(item.confidence)
  if (c === null) return { ok: false, reason: 'missing_confidence' }

  const value = { formType, taxYear, pageStart, confidence: c }
  const pageEnd = positiveInt(item.pageEnd)
  if (pageEnd !== null) value.pageEnd = pageEnd
  for (const name of ['taxpayerName', 'entityName', 'propertyAddress']) {
    if (item[name] == null || item[name] === '') continue
    const v = safeText(item[name])
    if (!v) return { ok: false, reason: `unsafe_${name}` }
    value[name] = v
  }
  if (item.ownershipPercent != null && item.ownershipPercent !== '') {
    const n = amount(item.ownershipPercent)
    if (n === null || n < 0 || n > 100) return { ok: false, reason: 'invalid_ownership_percent' }
    value.ownershipPercent = n
  }
  return { ok: true, value }
}

function validateLine(item) {
  if (!plain(item)) return { ok: false, reason: 'not_an_object' }
  const definition = TAX_LINE_DEFINITIONS[item.lineKey]
  if (!definition) return { ok: false, reason: 'unknown_tax_line' }
  if (!definition.formTypes.includes(item.formType)) return { ok: false, reason: 'line_not_on_form' }
  const taxYear = year(item.taxYear)
  if (taxYear === null) return { ok: false, reason: 'invalid_tax_year' }
  const n = amount(item.amount)
  if (n === null) return { ok: false, reason: 'invalid_amount' }
  const page = positiveInt(item.page)
  if (page === null) return { ok: false, reason: 'missing_line_page' }
  const c = confidence(item.confidence)
  if (c === null) return { ok: false, reason: 'missing_confidence' }
  const lineLabel = safeText(item.lineLabel)
  if (!lineLabel) return { ok: false, reason: 'missing_line_label' }

  const value = {
    lineKey: item.lineKey, formType: item.formType, taxYear, amount: n,
    page, lineLabel, confidence: c,
  }
  for (const name of ['taxpayerName', 'entityName', 'propertyAddress']) {
    if (item[name] == null || item[name] === '') continue
    const v = safeText(item[name])
    if (!v) return { ok: false, reason: `unsafe_${name}` }
    value[name] = v
  }
  if (item.rawText != null && item.rawText !== '') {
    const v = safeText(item.rawText)
    if (v) value.rawText = v
  }
  return { ok: true, value }
}

const formSignature = (f) => [f.formType, f.taxYear, normalized(f.taxpayerName), normalized(f.entityName), normalized(f.propertyAddress)].join('|')
const lineSignature = (l) => [l.lineKey, l.taxYear, normalized(l.taxpayerName), normalized(l.entityName), normalized(l.propertyAddress)].join('|')

export const TAX_FORM_SCHEMA = Object.freeze({
  type: 'array', maxItems: MAX_TAX_FORMS,
  description: 'Tax returns only. Inventory every supported form in the uploaded package.',
  items: {
    type: 'object', additionalProperties: false,
    required: ['formType', 'taxYear', 'pageStart', 'confidence'],
    properties: {
      formType: { type: 'string', enum: [...TAX_FORM_TYPES] },
      taxYear: { type: 'integer' },
      taxpayerName: { type: ['string', 'null'] },
      entityName: { type: ['string', 'null'] },
      propertyAddress: { type: ['string', 'null'] },
      ownershipPercent: { type: ['number', 'null'] },
      pageStart: { type: 'integer' },
      pageEnd: { type: ['integer', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
})

export const TAX_LINE_SCHEMA = Object.freeze({
  type: 'array', maxItems: MAX_TAX_LINE_ITEMS,
  description: 'Tax returns only. Transcribe only the normalized line keys in the closed vocabulary.',
  items: {
    type: 'object', additionalProperties: false,
    required: ['lineKey', 'formType', 'taxYear', 'amount', 'page', 'lineLabel', 'confidence'],
    properties: {
      lineKey: { type: 'string', enum: [...TAX_LINE_KEYS] },
      formType: { type: 'string', enum: [...TAX_FORM_TYPES] },
      taxYear: { type: 'integer' },
      amount: { type: 'number' },
      taxpayerName: { type: ['string', 'null'] },
      entityName: { type: ['string', 'null'] },
      propertyAddress: { type: ['string', 'null'] },
      page: { type: 'integer' },
      lineLabel: { type: 'string' },
      rawText: { type: ['string', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
})
