// The seam that was silently broken twice: reading the borrower's 1003 answers into the
// analysis. Both failures were the same shape — a path or a stub that returned nothing, and
// nothing complained. These tests make that class of bug loud.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applicationFactsFromState } from './applicationFacts.js'
import { isKnownField } from '../conversational-1003/applicationCatalog.js'

const row = (path, value) => ({ field_path: path, normalized_value: { value } })

// Every concrete path this module can ever read. If a catalog rename orphans one of these, this
// list is what fails — instead of the panel quietly running on an empty application.
const PATHS_READ = [
  'parties[0].income[0].monthlyEquivalent',
  'parties[0].employment[0].isCurrent',
  'parties[0].employment[0].employmentType',
  'parties[0].employment[0].startDate',
  'loan.requestedLoanAmount',
  'loan.purchasePrice',
  'loan.estimatedPropertyValue',
  'parties[0].liabilities[0].creditorName',
  'parties[0].liabilities[0].monthlyPayment',
  'parties[0].liabilities[0].unpaidBalance',
  'parties[0].hasAnyLiabilities',
]

test('every path this module reads exists in the catalog', () => {
  for (const p of PATHS_READ) assert.ok(isKnownField(p), `${p} is not a catalog field`)
})

test('income is the sum of the monthly equivalents, not the first row', () => {
  // Base + overtime + bonus are separate income entries; that is what they exist to add up to.
  const f = applicationFactsFromState([
    row('parties[0].income[0].monthlyEquivalent', 7200),
    row('parties[0].income[1].monthlyEquivalent', 900),
    row('parties[1].income[0].monthlyEquivalent', 5000), // co-borrower, not party 0
  ])
  assert.equal(f.monthlyIncome, 8100)
})

test('the current job wins over a previous one for the start date', () => {
  const f = applicationFactsFromState([
    row('parties[0].employment[0].isCurrent', false),
    row('parties[0].employment[0].startDate', '2015-01'),
    row('parties[0].employment[1].isCurrent', true),
    row('parties[0].employment[1].startDate', '2024-03'),
    row('parties[0].employment[1].employmentType', 'self_employed'),
  ])
  assert.equal(f.employmentStartDate, '2024-03')
  assert.equal(f.selfEmployed, true)
})

test('the loan amount comes from requestedLoanAmount — the field that actually exists', () => {
  // The first version read 'loan.amount', which is not a field, and LTV never computed.
  const f = applicationFactsFromState([row('loan.requestedLoanAmount', 496000)])
  assert.equal(f.loanAmount, 496000)
})

test('the stated purchase price flows through, with refi value as its fallback', () => {
  assert.equal(applicationFactsFromState([row('loan.purchasePrice', 620000)]).purchasePrice, 620000)
  assert.equal(applicationFactsFromState([row('loan.estimatedPropertyValue', 700000)]).purchasePrice, 700000)
})

test('military service is unknown-or-true, never false', () => {
  // false would silently rule VA out for everyone who has not answered the question yet.
  assert.equal(applicationFactsFromState([]).veteran, undefined)
  assert.equal(applicationFactsFromState([
    row('parties[0].employment[0].isCurrent', true),
    row('parties[0].employment[0].employmentType', 'military'),
  ]).veteran, true)
  assert.equal(applicationFactsFromState([
    row('parties[0].employment[0].isCurrent', true),
    row('parties[0].employment[0].employmentType', 'w2_employee'),
  ]).veteran, undefined)
})

test('declared liabilities come through for the undisclosed rule', () => {
  const f = applicationFactsFromState([
    row('parties[0].liabilities[0].creditorName', 'Chase Card'),
    row('parties[0].liabilities[0].monthlyPayment', 185),
  ])
  assert.equal(f.liabilities.length, 1)
  assert.equal(f.liabilities[0].creditorName, 'Chase Card')
})

test('an empty application yields nulls, never zeros', () => {
  const f = applicationFactsFromState([])
  assert.equal(f.monthlyIncome, null)
  assert.equal(f.loanAmount, null)
  assert.equal(f.employmentStartDate, null)
  assert.deepEqual(f.liabilities, [])
})
