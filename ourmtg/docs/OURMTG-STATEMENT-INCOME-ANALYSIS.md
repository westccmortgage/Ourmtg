# OurMtg Statement Income Analysis

## Product boundary

This feature prepares a bank-statement income worksheet for a licensed human reviewer. It
does not approve a loan, set `loan_files.preapproval_*`, issue a pre-approval letter, or
make an underwriting decision.

```text
borrower uploads requested statements
-> server extracts statement month + total deposits from digital PDFs
-> deterministic calculation prepares a review-required worksheet
-> loan-team user verifies every month, exclusions, expense factor, and ownership
-> loan-team user confirms reviewed monthly income
-> borrower sees only that reviewed summary
-> pre-approval remains a separate human action
```

## First-version scope

- Personal or business statements.
- 12- or 24-month periods.
- One PDF may contain multiple monthly statements; pages are grouped by statement month.
- Business calculation supports a reviewer-controlled expense factor and borrower ownership.
- Personal statements do not apply a business expense factor.
- Recent three-month decline versus the prior three months is flagged at more than 10%; it
  never becomes an automatic denial or approval.
- Digital PDFs are parsed automatically. Scanned PDFs and images are marked for manual entry.
- Extracted values always begin as `needs_review=true`.

## Deterministic calculation

For each statement month:

```text
eligible deposits = total deposits - reviewer-confirmed exclusions
```

Personal statements:

```text
monthly qualifying income = eligible deposits / distinct statement months
```

Business statements:

```text
monthly qualifying income = average eligible monthly deposits
                          x (1 - expense factor)
                          x borrower ownership
```

The calculation is reproducible code. PDF extraction supplies inputs; it does not supply a
decision.

## Security and visibility

- Tables: `statement_income_analyses`, `statement_income_months`.
- RLS is enabled and all `anon`/`authenticated` table privileges are revoked.
- There are no browser SELECT policies on either table.
- Netlify Functions authorize every read/write using the existing file owner/team/access
  boundary.
- Internal users receive the worksheet. Borrowers receive only a reviewed monthly-income
  summary through a column-scoped server response.
- Realtor, escrow, and title roles never receive statement analysis data.

## Database rollout

`supabase/delta/002_statement_income_analysis.sql` is an idempotent, wrong-project-guarded
production delta. It was applied to project `diqukqhbmqcheffhensp` on 2026-07-18 after
explicit approval. Production verification returned both expected tables, RLS enabled, and
an empty browser-privilege list.

```json
{
  "tables": ["statement_income_analyses", "statement_income_months"],
  "rls_enabled": true,
  "browser_privileges": []
}
```

## Required acceptance

1. Delta 002 applied only to project `diqukqhbmqcheffhensp`; verification passed.
2. Upload a known 12-month digital PDF package to a test loan.
3. Compare extracted months and deposit totals to the statements page by page.
4. Enter exclusions, save, and verify the deterministic result manually.
5. Confirm the reviewed income and verify the borrower sees only the reviewed summary.
6. Verify the action did not set or change pre-approval amount or stage.
7. Upload a scanned/image statement and verify that manual review is required instead of a
   fabricated value.
