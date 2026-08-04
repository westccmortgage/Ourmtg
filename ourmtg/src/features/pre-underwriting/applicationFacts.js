// The borrower's 1003 answers, in the shape the pre-underwriting layers read.
//
// Pure and separate from both endpoints because both need it, and because the first version of
// this logic — six hardcoded paths inside the review endpoint — had every single path wrong and
// nothing failed: an unknown path reads as undefined, undefined reads as "the borrower hasn't
// answered", and the panel quietly ran on an empty application. The test alongside this module
// holds every path it reads against the catalog, so a catalog rename breaks a test instead of
// silently blanking the panel.

import { declaredLiabilities } from './creditImport.js'

/**
 * Exported and pure so a test can hold it against the catalog. The first version of this
 * function read six paths and every one of them was wrong — 'loan.amount' for
 * 'loan.requestedLoanAmount', a scalar 'parties[0].income.amount' for the indexed income
 * group — and nothing failed: an unknown path reads as undefined, undefined reads as "the
 * borrower hasn't answered", and the panel quietly runs on an empty application.
 */
export function applicationFactsFromState(state) {
  const rows = state || []
  const unwrapV = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v)
  const value = (path) => unwrapV(rows.find((s) => s.field_path === path)?.normalized_value)
  const group = (re) => rows
    .map((s) => ({ m: re.exec(String(s.field_path)), v: unwrapV(s.normalized_value) }))
    .filter((x) => x.m && x.v !== null && x.v !== undefined)

  // Qualifying income is the SUM of the borrower's monthly-equivalent income rows — base plus
  // overtime plus bonus — because that is what those rows exist to add up to. The engine derives
  // monthlyEquivalent per income entry as system_derived.
  const monthly = group(/^parties\[0\]\.income\[\d+\]\.monthlyEquivalent$/)
    .reduce((n, x) => n + (Number(x.v) || 0), 0)

  // Current job's start date: the employment entry whose isCurrent is true, else entry 0.
  const currentIdx = group(/^parties\[0\]\.employment\[(\d+)\]\.isCurrent$/)
    .find((x) => x.v === true)?.m[1] ?? '0'
  const employmentType = value(`parties[0].employment[${currentIdx}].employmentType`)

  return {
    monthlyIncome: monthly > 0 ? monthly : null,
    employmentStartDate: value(`parties[0].employment[${currentIdx}].startDate`) ?? null,
    selfEmployed: employmentType === 'self_employed',
    loanAmount: value('loan.requestedLoanAmount') ?? null,
    // Purchase price from the borrower's own answer, so LTV can compute before a contract is read.
    purchasePrice: value('loan.purchasePrice') ?? value('loan.estimatedPropertyValue') ?? null,
    // 'military' as the employment type is the only signal the 1003 carries here; anything else
    // is "unknown", never false — false would silently rule out VA.
    veteran: employmentType === 'military' ? true : undefined,
    liabilities: declaredLiabilities(rows, 0),
  }
}
