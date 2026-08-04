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
| Credit score, or anything derived from the credit report | **never, from this system** | yes |
| Whether they have authorized a credit pull | yes — it is their own consent | yes |

### The credit report is stricter than the rest of the table

Added 2026-08-03, when credit was actually wired in. Everything else above is *withheld pending
review*; the credit report is different in kind. A borrower learning their score or their
standing from a page this system rendered is an adverse-action-adjacent disclosure made by the
wrong party, without the notice that legally attaches to it. So `credit_report` sits in
`NEVER_ECHOED` alongside `id_photo`, and no reviewed-release path is provided for it.

The consent itself is the exception, and it points the other way: the borrower must see, and
must be the only one able to give it. `credit-authorization` refuses a POST from the loan team
including the file's owner. A loan officer taking a 1003 over the phone is ordinary practice; a
loan officer clicking "I authorize" for someone else is not the same act, and the FCRA's
permissible purpose does not survive it.

### Who can produce a document is part of the boundary

A credit tri-merge is required, usually missing, and impossible for a consumer to obtain.
Listing it as a borrower document puts an impossible request in front of them and then waits on
them for it. `providedBy` in the catalog splits the missing list in two: what the borrower can
send, and what the loan team has to go get.

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

## What was built against this, and where it is enforced

| Rule | Enforced in |
|---|---|
| A finding never reaches a borrower | `pre-underwriting-*` are internal-only; endpoint tests assert 403 for borrower and realtor |
| Nothing can express an approval | no column in delta 006, no action in the review endpoint, asserted in both the rehearsal and the endpoint tests |
| A dismissal must say why | refused at the endpoint; a resolution with no decider is refused by a check constraint |
| The score is a file measure, not a person measure | `readiness.js` carries `meaning` / `notMeaning`, rendered next to the number every time |
| Programs are suitability, not eligibility | `programFit.js` returns the guideline each comparison used and a `notChecked` list; nothing is ruled out on a number nobody has |
| Numbers are null rather than estimated | `qualifyingFacts.js` — every figure returns null with a reason when an input is missing |
| The credit score is the middle of three | `representativeScore` — averaging qualifies people who do not qualify |

### Credit liabilities flow into the 1003 — planned, shown, then written

Added 2026-08-04. Every obligation on the report must end up in section 2c, because that is what
the ratios are computed from and what the borrower attests to. The import:

- **reconciles first** — a declared debt is matched (by last-four, then by creditor name), never
  duplicated, never called undisclosed; the undisclosed rule and the reconciler share one
  definition of "the same creditor"
- **filters what does not belong** — a closed account with no balance is history, not a liability
- **never drops a deferred debt** — a $0 payment against a balance imports at $0 and is flagged
  "payment to be established"; silently dropping it makes a $60k student loan cost nothing
- **never carries the account number** — it is a matching key, and `liabilities[].accountNumber`
  stays a secure field with its own control
- **writes through the same reducer as the interview**, as source `imported_credit`, landing as
  `candidate` — the borrower still sees and confirms every imported row before they attest
- **is a button, not a side effect** — the panel lists exactly what would be written before
  anyone presses it, and an attested application refuses the import outright

## Still open

- **The credit authorization wording is a draft** (`reviewed: false`). It has to pass a compliance
  review before a real borrower reads it. The flag exists so this cannot be forgotten silently.
- **Adverse action.** Nothing here issues one, and nothing here should. If a file is declined,
  that notice comes from the lender's own process — this system's job is to have made the
  reasoning legible, not to send the letter.
- **Transaction-level bank reads.** `largeDeposits` works today only on deposits a caller has
  collected; the extraction reads statement totals, not the ledger. An empty deposit list means
  "we have not looked", never "there is nothing there", and the rule is written so absence
  produces no finding.
