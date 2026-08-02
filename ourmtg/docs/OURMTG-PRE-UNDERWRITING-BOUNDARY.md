# Autopilot Pre-Underwriting — what the borrower sees, and what stays inside

**Owner decision, 2026-07-30 (Anatoliy Kanevsky).** Recorded before any of it was built, because
this is the kind of boundary that is cheap to hold from the start and expensive to add later.

## The rule

**The borrower sees what is missing. Nothing else.**

Readiness percentages, risk findings, calculated income, ratios, and program suitability stay
internal until a licensed human reviews them and chooses to release them. This is the same shape
the statement-income worksheet already uses: the server prepares, a reviewer verifies every line,
and only the reviewed summary reaches the borrower.

| | Borrower | Loan team |
|---|---|---|
| Which documents are still needed | yes | yes |
| Which pages or months are incomplete | yes | yes |
| That something needs explaining (e.g. a gap, a deposit) | yes, as a request | yes, with the finding |
| Readiness score | no | yes |
| Calculated qualifying income, DTI, LTV, reserves, cash to close | only after review | yes |
| Risk findings (large deposits, NSF, undisclosed liabilities, inconsistencies) | no | yes |
| Program suitability / recommendations | no | yes |

## Why, in plain terms

A readiness score or a program list shown to an applicant reads as a decision on their
application, whatever the disclaimer next to it says. Decisions on credit applications carry
obligations — notice, reasons, timing — that a number rendered by software does not satisfy on
its own. Keeping the analysis internal until a human releases it keeps the product on the side
of *preparing* a file, which is what it is for.

Asking for a document is not a decision, which is why the missing list can go straight to the
borrower. "You need a letter explaining the gap in employment" is a request. "Your readiness is
64% and DSCR is not applicable" is a conclusion about them.

## What this means for how the data is stored

- Analysis output is written to server-only tables, the same way application state is: RLS on,
  all `anon` and `authenticated` privileges revoked, reachable only through gateway functions.
- Every finding carries a review state. Nothing reaches a borrower-visible surface until a
  loan-team user has acted on it — the projection the borrower reads is built from reviewed
  items only, never filtered client-side.
- The missing-documents list is derived, not copied: it names documents and pages, never the
  reasoning that produced the rest of the analysis.

## What the agent may never do

It may not approve, deny, pre-approve, counteroffer, price, or select a program. It prepares
findings for a person. Every one of those verbs belongs to a licensed human, and the surfaces
that perform them stay separate actions, as `loan_files.preapproval_*` already is.
