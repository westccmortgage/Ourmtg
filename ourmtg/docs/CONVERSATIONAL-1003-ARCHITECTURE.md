# Conversational 1003 — Architecture

Status: **MVP, behind a default-off flag.** Not deployed, no migrations applied.

## The one idea

A language model is very good at understanding what a borrower *meant* and very bad at being a
system of record. So it is used for exactly the first job and structurally prevented from doing
the second.

```
borrower words (text or voice)
        │
        ▼
AI language interpreter            ← may identify facts; may not decide anything
        │  strict JSON contract
        ▼
turnContract.validateTurnResponse  ← untrusted input boundary; unknown paths discarded
        │
        ▼
applicationCatalog (allowlist)     ← 109 versioned fields; the model cannot invent one
        │
        ▼
normalization + applicationReducer ← deterministic parsing; append-only event log
        │
        ▼
applicationRules + completenessEngine ← what is required, what is complete
        │
        ▼
questionPlanner                    ← what to ask next (model may re-word, never re-decide)
        │
        ▼
borrower UI
```

## What the model may and may not do

| May | May not |
|---|---|
| Interpret the borrower's language | Invent application data |
| Identify possible facts | Create a field path outside the catalog |
| Notice a misunderstanding | Decide a required field is not required |
| Explain a question in plain language | Mark the application complete |
| Propose warmer wording | Replace confirmed data |
| Summarize what was captured | Approve, deny, underwrite, or promise anything |

Each "may not" is enforced in code, not by prompting alone:

| Rule | Enforced by |
|---|---|
| No invented fields | `turnContract.validateExtraction` → `isKnownField` |
| No requiredness changes | `applicationRules.evaluateRequirement` — the model has no input |
| No completion claim | `completenessEngine.computeCompleteness` — a pure count |
| No secure-field writes | `applicationReducer.validateCandidate` + catalog `secureEntry` |
| No demographic inference | catalog `aiInferenceForbidden` + reducer + contract, three layers |
| No instruction-following from borrower text | `looksLikeInjection` on prose *and* candidates |

## Module map

### Pure engine — `src/features/conversational-1003/`

Framework-free ESM, imported unchanged by the browser bundle, the Netlify functions, and the
test runner. This is the part that is liftable into RMTG or an embedded workspace.

| Module | Responsibility |
|---|---|
| `types.js` | Frozen vocabularies + schema/catalog/rules versions |
| `applicationCatalog.js` | The 109-field allowlist; labels, purposes, official mappings |
| `normalization.js` | Deterministic parsing (amounts, months, durations, frequencies) in en/es/ru |
| `applicationRules.js` | Conditional requirements + 24-month history coverage analysis |
| `applicationReducer.js` | Append-only state machine; supersession, conflicts, provenance |
| `completenessEngine.js` | Applicable-required vs resolved; structural gaps; section rollup |
| `questionPlanner.js` | Deterministic next question; escalation ladder; loop safety |
| `confirmationPolicy.js` | Which values interrupt for confirmation |
| `misunderstanding.js` | Detection + blame-free recovery copy |
| `turnContract.js` | Strict validation of model output; injection and PII scrubbing |
| `engine.js` | Orchestrates one turn; builds minimum provider context |
| `review.js` | Borrower and team projections |
| `attestationText.js` | Versioned attestation wording (draft, not counsel-reviewed) |
| `providers/` | Provider interface, deterministic mock, versioned system prompt |

### Server — `netlify/functions/`

| Function | Purpose |
|---|---|
| `application-session` | Load/resume: next question, review, progress |
| `application-turn` | One borrower turn (the §24 ordering) |
| `application-confirm` | Confirm / resolve conflict / decline / unsure |
| `application-secure-field` | Masked SSN + account entry |
| `application-attest` | Deterministic gate + attestation record |
| `application-team-review` | Team view and team actions |
| `_lib/conversational1003.mjs` | Flag, provider selection, live Anthropic adapter |
| `_lib/applicationRepo.mjs` | Event log ⇄ engine state; idempotent turn claims |

### Client — `src/features/conversational-1003/pages|components/`

`ApplicationAssistant` (borrower workspace), `ApplicationTeamReview` (loan team),
`VoiceInput`, `SecureFieldInput`, `ApplicationReview`, `AttestationPanel`.

## Why the event log is the source of truth

`application_field_events` is append-only. The current-value table
(`application_field_state`) is a projection the server maintains for query convenience and can
be rebuilt from the log at any time — `applicationRepo.loadState` deliberately reads the **log**,
not the projection, so the projection can never quietly become authoritative.

This is what makes three required behaviors fall out for free:

- **A changed answer supersedes, never deletes** — the prior event stays, flagged `superseded`.
- **Resume is exact** — replaying the log reproduces the state bit-for-bit (asserted in tests).
- **The team can always see where a value came from** — source, confidence, and the borrower's
  own words travel with every event.

## The turn ordering (§24)

```
1. persist the borrower's turn        ← claimTurn(); idempotency key now owns this turn
2. acknowledge durable receipt
3. interpret                          ← may time out, fail, or be refused
4. validate against the contract      ← a bad response is discarded entirely
5. update state (append-only)
6. compute the next question          ← deterministic, always succeeds
7. return
```

Steps 5–7 do not depend on 3–4 succeeding. When the provider is unavailable the borrower gets
their answer preserved, a plain-language notice, and the next question — never a dead end and
never a request to retype.

## Multi-tenancy

Every table carries `organization_id`, `loan_file_id`, and (where applicable) `party_id`.
`owner_user_id` alone is **not** the tenancy boundary (§23). Authorization is enforced in code on
every request via the existing `resolveAccess` / `canSeeFinancials` helpers, and all new tables
are server-only (RLS on, browser privileges revoked) exactly like `statement_income_analyses`.

## Portability

The pure engine has no imports from React, Node, Supabase, or Netlify. To run it elsewhere you
supply three things: a store for the event log, an `ApplicationAIProvider`, and a UI. Nothing in
`src/features/conversational-1003/` (outside `pages/`, `components/`, and `api.js`) knows OurMTG
exists.
