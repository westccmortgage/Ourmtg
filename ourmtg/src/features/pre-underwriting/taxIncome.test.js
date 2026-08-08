// The tax-return reader may be probabilistic; the income worksheet may not be. These tests feed
// model-shaped output through the real extraction contract and assert every important number by
// hand, including de-duplication and the rule that no calculated amount becomes final qualifying
// income without a person.

import test from 'node:test'
import assert from 'node:assert/strict'
import { validateExtractionResponse } from './extractionContract.js'
import { TAX_LINE_DEFINITIONS } from './taxReturnContract.js'
import { analyzeTaxReturns } from './taxIncome.js'

const form = (formType, taxYear, extra = {}) => ({
  formType, taxYear, pageStart: 1, pageEnd: 2, confidence: 0.98, ...extra,
})
const line = (lineKey, formType, taxYear, amount, extra = {}) => ({
  lineKey, formType, taxYear, amount, page: 2,
  lineLabel: TAX_LINE_DEFINITIONS[lineKey].label,
  confidence: 0.97, ...extra,
})

function fullYear(taxYear, values) {
  const taxpayerName = 'Daria N'
  const business = 'Daria Consulting LLC'
  const corp = 'North Coast Design Inc'
  const propertyAddress = '10 Main St'
  const raw = {
    docKey: 'tax_return_full', docKeyConfidence: 0.99,
    fields: [
      { name: 'taxpayerName', value: taxpayerName, confidence: 0.99 },
      { name: 'pagesPresent', value: 30, confidence: 0.99 },
      { name: 'pagesTotal', value: 30, confidence: 0.99 },
    ],
    taxForms: [
      form('1040', taxYear, { taxpayerName }),
      form('w2', taxYear, { taxpayerName, entityName: 'West Coast Capital' }),
      form('1099_int', taxYear, { taxpayerName, entityName: 'Bank One' }),
      form('schedule_c', taxYear, { taxpayerName, entityName: business }),
      form('schedule_e', taxYear, { taxpayerName, propertyAddress }),
      form('1120s', taxYear, { entityName: corp, ownershipPercent: 50 }),
      form('k1_1120s', taxYear, { taxpayerName, entityName: corp, ownershipPercent: 50 }),
    ],
    taxLineItems: [
      line('form1040_wages', '1040', taxYear, values.wages, { taxpayerName }),
      line('w2_wages', 'w2', taxYear, values.wages, { taxpayerName, entityName: 'West Coast Capital' }),
      line('form1040_taxable_interest', '1040', taxYear, values.interest, { taxpayerName }),
      line('form1099_interest', '1099_int', taxYear, values.interest, { taxpayerName, entityName: 'Bank One' }),
      line('schedulec_net_profit', 'schedule_c', taxYear, values.scheduleC, { taxpayerName, entityName: business }),
      line('schedulec_depreciation', 'schedule_c', taxYear, values.scheduleCDep, { taxpayerName, entityName: business }),
      line('schedulec_business_use_home', 'schedule_c', taxYear, values.homeOffice, { taxpayerName, entityName: business }),
      line('schedulee_rental_income_loss', 'schedule_e', taxYear, values.rental, { taxpayerName, propertyAddress }),
      line('schedulee_rental_depreciation', 'schedule_e', taxYear, values.rentalDep, { taxpayerName, propertyAddress }),
      line('form1120s_ordinary_income', '1120s', taxYear, values.corp, { entityName: corp }),
      line('form1120s_depreciation', '1120s', taxYear, values.corpDep, { entityName: corp }),
      // This is the borrower's share of the same corporation return and must not be added again.
      line('k1_ordinary_business_income', 'k1_1120s', taxYear, (values.corp + values.corpDep) * 0.5, { taxpayerName, entityName: corp }),
    ],
  }
  const validated = validateExtractionResponse(raw, { expectedDocKey: 'tax_return_full' })
  assert.equal(validated.ok, true)
  assert.deepEqual(validated.rejected, [])
  return { ...validated.value, documentId: `tax-${taxYear}`, createdAt: `${taxYear + 1}-04-15T00:00:00Z` }
}

test('a two-year personal/business package produces the hand-checked full income report', () => {
  const older = fullYear(2024, {
    wages: 80000, interest: 1000,
    scheduleC: 60000, scheduleCDep: 10000, homeOffice: 2000,
    rental: -6000, rentalDep: 12000,
    corp: 100000, corpDep: 20000,
  })
  const newer = fullYear(2025, {
    wages: 85000, interest: 1200,
    scheduleC: 70000, scheduleCDep: 8000, homeOffice: 2000,
    rental: -4000, rentalDep: 12000,
    corp: 120000, corpDep: 20000,
  })

  const report = analyzeTaxReturns([older, newer], { asOf: Date.parse('2026-08-08T00:00:00Z') })
  assert.equal(report.status, 'prepared_for_review')
  assert.equal(report.missing.length, 0)
  assert.equal(report.formsRead, 14)
  assert.equal(report.years[0].forms.length, 7)
  assert.equal(report.years[0].calculatedAnnual, 219000)
  assert.equal(report.years[1].calculatedAnnual, 244200)
  assert.deepEqual(report.comparison.years, [2024, 2025])
  assert.equal(report.comparison.trend, 'increasing')
  assert.equal(report.comparison.method, 'two-year average')
  assert.equal(report.comparison.calculatedAnnual, 231600)
  assert.equal(report.comparison.calculatedMonthly, 19300)

  // W-2/1099 and K-1 source forms are present for reconciliation, never double-counted.
  const y2024 = report.years[0]
  assert.equal(y2024.sources.find((s) => s.label === 'Wages').annual, 80000)
  assert.equal(y2024.sources.find((s) => s.label === 'Daria Consulting LLC').annual, 72000)
  assert.equal(y2024.sources.find((s) => s.label === 'North Coast Design Inc').annual, 60000)
  assert.ok(y2024.sources.find((s) => s.label === 'K-1 — North Coast Design Inc').crossChecks
    .some((x) => x.reason === 'represented_on_1120s'))
  assert.ok(report.reconciliation.every((r) => r.status === 'matched'))

  // The report prepares the number but never turns itself into an underwriting decision.
  assert.equal(report.humanReviewRequired, true)
  assert.equal(report.qualifyingIncome.annual, null)
  assert.equal(report.qualifyingIncome.monthly, null)
  assert.ok(report.reviewFlags.some((f) => f.code === 'business_cash_flow_review'))
  assert.ok(report.reviewFlags.some((f) => f.code === 'rental_income_review'))
})

test('a material decline uses the most recent year rather than averaging it away', () => {
  const make = (taxYear, wages) => {
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [form('1040', taxYear, { taxpayerName: 'Daria N' })],
      taxLineItems: [line('form1040_wages', '1040', taxYear, wages, { taxpayerName: 'Daria N' })],
    })
    return { ...v.value, documentId: `wages-${taxYear}` }
  }
  const report = analyzeTaxReturns([make(2024, 100000), make(2025, 80000)])
  assert.equal(report.status, 'prepared_for_review')
  assert.equal(report.comparison.trend, 'declining')
  assert.equal(report.comparison.calculatedAnnual, 80000)
  assert.equal(report.comparison.calculatedMonthly, 6666.67)
})

test('missing ownership makes business income null instead of assuming one hundred percent', () => {
  const make = (taxYear) => {
    const corp = 'North Coast Design Inc'
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [
        form('1040', taxYear, { taxpayerName: 'Daria N' }),
        form('1120s', taxYear, { entityName: corp }),
      ],
      taxLineItems: [line('form1120s_ordinary_income', '1120s', taxYear, 100000, { entityName: corp })],
    })
    return { ...v.value, documentId: `corp-${taxYear}` }
  }
  const report = analyzeTaxReturns([make(2024), make(2025)])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.comparison.calculatedAnnual, null)
  assert.ok(report.missing.some((m) => m.code === 'missing_ownership_percent'))
  assert.equal(report.years[0].sources.find((s) => s.entityName === 'North Coast Design Inc').annual, null)
})

test('an incomplete newest year is not skipped in favor of two older convenient years', () => {
  const wages = (taxYear, amount) => {
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [form('1040', taxYear, { taxpayerName: 'Daria N' })],
      taxLineItems: [line('form1040_wages', '1040', taxYear, amount, { taxpayerName: 'Daria N' })],
    })
    return { ...v.value, documentId: `wages-${taxYear}` }
  }
  const brokenLatest = validateExtractionResponse({
    docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
    taxForms: [
      form('1040', 2025, { taxpayerName: 'Daria N' }),
      form('1120s', 2025, { entityName: 'No Ownership Inc' }),
    ],
    taxLineItems: [line('form1120s_ordinary_income', '1120s', 2025, 200000, { entityName: 'No Ownership Inc' })],
  }).value
  const report = analyzeTaxReturns([
    wages(2023, 90000), wages(2024, 100000), { ...brokenLatest, documentId: 'broken-2025' },
  ])
  assert.equal(report.years.find((y) => y.taxYear === 2025).calculatedAnnual, null)
  assert.equal(report.comparison.calculatedAnnual, null)
  assert.deepEqual(report.comparison.years, [])
})

test('K-1 guaranteed payments are taxpayer share and are not multiplied by ownership twice', () => {
  const make = (taxYear) => {
    const entityName = 'Harbor Partners'
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [
        form('1040', taxYear, { taxpayerName: 'Daria N' }),
        form('1065', taxYear, { entityName, ownershipPercent: 30 }),
        form('k1_1065', taxYear, { taxpayerName: 'Daria N', entityName, ownershipPercent: 30 }),
      ],
      taxLineItems: [
        line('form1040_total_income', '1040', taxYear, 50000, { taxpayerName: 'Daria N' }),
        line('form1065_ordinary_income', '1065', taxYear, 100000, { entityName }),
        line('k1_ordinary_business_income', 'k1_1065', taxYear, 30000, { taxpayerName: 'Daria N', entityName }),
        line('k1_guaranteed_payments', 'k1_1065', taxYear, 20000, { taxpayerName: 'Daria N', entityName }),
      ],
    })
    return { ...v.value, documentId: `partnership-${taxYear}` }
  }
  const report = analyzeTaxReturns([make(2024), make(2025)])
  assert.equal(report.status, 'prepared_for_review')
  assert.equal(report.years[0].calculatedAnnual, 50000)
  assert.equal(report.years[0].sources.find((s) => s.label === 'Harbor Partners').annual, 30000)
  assert.equal(report.years[0].sources.find((s) => s.label === 'K-1 — Harbor Partners').annual, 20000)
})

test('a K-1 at or above 25 percent names the absent controlling business return', () => {
  const make = (taxYear) => {
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [
        form('1040', taxYear, { taxpayerName: 'Daria N' }),
        form('k1_1065', taxYear, { taxpayerName: 'Daria N', entityName: 'Harbor Partners', ownershipPercent: 30 }),
      ],
      taxLineItems: [line('k1_ordinary_business_income', 'k1_1065', taxYear, 40000, { taxpayerName: 'Daria N', entityName: 'Harbor Partners' })],
    })
    return { ...v.value, documentId: `k1-${taxYear}` }
  }
  const report = analyzeTaxReturns([make(2024), make(2025)])
  assert.equal(report.status, 'incomplete')
  assert.ok(report.missing.some((m) => m.code === 'missing_business_return' && /1065/.test(m.message)))
  assert.ok(report.reviewFlags.some((f) => f.code === 'k1_without_controlling_return'))
  assert.equal(report.comparison.calculatedAnnual, null)
})

test('1099 gross receipts without an expense schedule never become net income', () => {
  const make = (taxYear) => {
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [
        form('1040', taxYear, { taxpayerName: 'Daria N' }),
        form('1099_nec', taxYear, { taxpayerName: 'Daria N', entityName: 'Client Co' }),
      ],
      taxLineItems: [line('form1099_nec_compensation', '1099_nec', taxYear, 150000, {
        taxpayerName: 'Daria N', entityName: 'Client Co',
      })],
    })
    return { ...v.value, documentId: `nec-${taxYear}` }
  }
  const report = analyzeTaxReturns([make(2024), make(2025)])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.comparison.calculatedAnnual, null)
  assert.ok(report.missing.some((m) => m.code === 'missing_self_employment_schedule'))
  assert.equal(report.years[0].knownAnnual, 0)
})

test('an inventoried business schedule with no net-income base line keeps the package incomplete', () => {
  const make = (taxYear) => {
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [
        form('1040', taxYear, { taxpayerName: 'Daria N' }),
        form('schedule_c', taxYear, { taxpayerName: 'Daria N', entityName: 'Unreadable Business' }),
      ],
      taxLineItems: [line('form1040_wages', '1040', taxYear, 80000, { taxpayerName: 'Daria N' })],
    })
    return { ...v.value, documentId: `missing-base-${taxYear}` }
  }
  const report = analyzeTaxReturns([make(2024), make(2025)])
  assert.equal(report.status, 'incomplete')
  assert.ok(report.missing.some((m) => m.code === 'missing_required_tax_line' && /SCHEDULE_C/.test(m.message)))
})

test('conflicting reads remove the disputed line from totals and point to both source pages', () => {
  const raw = (id, amount) => {
    const v = validateExtractionResponse({
      docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
      taxForms: [form('1040', 2025, { taxpayerName: 'Daria N' })],
      taxLineItems: [line('form1040_wages', '1040', 2025, amount, { taxpayerName: 'Daria N' })],
    })
    return { ...v.value, documentId: id }
  }
  const report = analyzeTaxReturns([raw('copy-a', 80000), raw('copy-b', 90000)])
  const conflict = report.missing.find((m) => m.code === 'conflicting_line_values')
  assert.ok(conflict)
  assert.equal(conflict.evidence.length, 2)
  assert.deepEqual(conflict.evidence.map((e) => e.documentId).sort(), ['copy-a', 'copy-b'])
  assert.equal(report.years[0].calculatedAnnual, null)
})
