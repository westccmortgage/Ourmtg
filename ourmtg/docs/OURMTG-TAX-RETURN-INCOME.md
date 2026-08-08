# OurMTG — complete tax-return income analysis

Status: implemented behind the existing Pre-Underwriting flags; stub/fixture verified; **no live
model/PDF acceptance run yet**.

## Product contract

A loan-team user can upload `tax_return_full`, read it from the internal Pre-Underwriting panel,
and receive a source-linked income worksheet. The output is preparation for a licensed reviewer,
not an underwriting opinion. It cannot approve, deny, pre-approve, select a program or create
final qualifying income.

The report contains:

- form inventory by year, entity, ownership and PDF pages;
- income sources and signed base amounts;
- deterministic depreciation, depletion, amortization and home-office add-backs where the closed
  ruleset supports them;
- entity cash flow and ownership application;
- two-year totals, monthly equivalents and increasing/stable/declining trend;
- reconciliation of controlling return lines to W-2/1099/Schedule C support;
- excluded variable income, missing forms/years/ownership, conflicting reads and low-confidence
  source lines;
- exact document, form, year, page, printed line label, amount and confidence for every value.

`comparison.calculatedAnnual` and `comparison.calculatedMonthly` are working figures pending
review. `qualifyingIncome.annual` and `.monthly` are structurally null. The general DTI calculation
does not consume the tax figure.

## Supported package vocabulary

The model may inventory only:

- Form 1040 and Schedules 1, B, C, D, E and F;
- W-2; 1099-INT, DIV, NEC, MISC, K, R; SSA-1099;
- K-1 for 1120S, 1065 and 1041;
- Forms 1120, 1120S, 1065, 8825 and 4562.

The actual line-key allowlist and deterministic treatment are one source of truth in
`src/features/pre-underwriting/taxReturnContract.js`. Unknown forms and lines are omitted, never
mapped to a "close enough" field.

## Layer ownership

1. `documentIntake.mjs` sends one PDF/image and the closed schema to the model. A tax package gets
   a larger output budget and timeout, but the same fail-closed provider behavior.
2. `taxReturnContract.js` validates form/year/page/confidence, signed amounts, form-to-line
   compatibility, document inventory, SSN exclusion and prompt-injection boundaries.
3. `taxIncome.js` de-duplicates controlling/source forms, computes cash flow, applies ownership,
   compares years, reconciles totals and names every missing input.
4. `pre-underwriting-review.mjs` returns the report only to an authorized internal user; the panel
   renders the worksheet and source lines without a decision action.

The validated `taxForms` and `taxLineItems` arrays live inside the existing versioned
`document_extractions.fields` JSON payload. Re-reading a document supersedes its prior live read,
so no schema migration or second lifecycle was introduced.

## Fail-closed rules worth preserving

- Gross 1099-NEC/K/MISC receipts are not net income. Without Schedule C/E expenses they produce a
  named gap and contribute zero to the calculation.
- A K-1 at 25% ownership or more (or with ownership absent) requires its matching 1120S/1065.
  Missing business returns make the source and two-year calculation null.
- Entity-return income requires a single supported ownership percentage. Missing or conflicting
  ownership is null, never 100%.
- A W-2/1099/K-1 source form is a cross-check when its controlling 1040/schedule/entity return is
  present; it is not added twice.
- Conflicting copies remove the disputed line from arithmetic and retain both source pages.
- A declining two-year result uses the most recent year; stable/increasing results use the
  two-year average. That method is visible and still pending human confirmation.
- Capital gains, unemployment and other variable/unsupported items remain visible but excluded
  until a reviewer applies the relevant continuance and investor rules.

## Verification

Tests cover the extraction trust boundary, persistence through the fake PostgREST service,
internal-only panel response, missing business returns, missing ownership, gross-vs-net 1099
handling, duplicate source forms, conflicting reads, source evidence, trend logic and a
hand-calculated two-year package containing 1040, W-2/1099, Schedule C/E, 1120S and K-1.

## Acceptance still required before production use

1. Run representative real files: native IRS/tax-software PDFs, scanned returns, rotated pages,
   phone photos, large packages and amended returns.
2. Compare every extracted form/line and the final worksheet against a licensed reviewer's Form
   1084/Form 91 or investor-equivalent calculation; record false positives and omissions.
3. Confirm provider input/page/size limits and structured-output behavior on the configured live
   model. Current upload transport remains limited to roughly 20 MB and one model pass.
4. Add a human confirm/correct workflow for the worksheet before allowing its figure to feed DTI
   or any reviewed borrower summary.
5. Add current-year YTD business P&L/balance-sheet reconciliation, extension handling, amended
   return selection and investor-specific overlays. None is guessed today.
