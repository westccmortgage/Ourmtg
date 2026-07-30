# Conversational 1003 — Privacy and Retention

**This document describes what the code does. It is not a legal opinion and it does not claim
compliance with any regulation.** Items needing compliance-counsel review are marked ⚠ and
collected in `CONVERSATIONAL-1003-COMPLIANCE-REVIEW.md`.

Conversation transcripts here are **mortgage application data** — they contain income,
employment, assets, debts, and household facts. They are treated with the same seriousness as a
pay stub, not as chat logs.

## What is stored

| Data | Where | Why |
|---|---|---|
| Borrower's message text | `application_turns.borrower_text` | Evidence of what the borrower actually said; lets the team see original wording rather than only our interpretation |
| Original wording per field | `application_field_events.original_text` | Provenance for each captured value |
| Normalized field values | `application_field_events`, `application_field_state` | The application itself |
| Field history (every change) | `application_field_events` (append-only) | Audit trail; a changed answer supersedes rather than deletes |
| Question history per party | `application_parties.asked_history` | Attempts, confusion counts, skips — drives escalation and team flags |
| Turn metadata | `application_turns` | Idempotency, provider/model/prompt version, safety flags, processing state |
| Attestation record | `application_attestations` | Text version, presented/accepted timestamps, identity, IP, user agent, application snapshot |
| Masked secure fields | `application_secure_fields` | Last four + keyed digest only |
| Access audit | `portal_access_log` (existing) | Who touched which application, when |

## What is deliberately NOT stored

- **Full SSNs and full account numbers.** `application-secure-field` stores the last four plus an
  HMAC digest. The plaintext is not persisted by this migration. ⚠ *If the lender requires the
  full value for submission, that is a KMS/encryption decision the owner has not made — see the
  deployment doc. Do not add a plaintext column.*
- **Raw audio.** Voice uses the browser's own recognizer; text comes back, audio never leaves
  the device and is never uploaded.
- **Online-banking credentials, passwords, one-time codes.** Never requested. The secure control
  says so on screen.
- **Anything in a URL.** No application data, party id, or field value appears in a query string
  other than `loanFileId`, which is authorization-checked on every request.
- **localStorage.** No application data is cached client-side. (The existing language preference
  key `ourmtg_lang` is UI chrome only.)

## Redaction before persistence

Two layers run before any borrower text is written:

1. `redactSensitive()` replaces SSN-shaped and long-account-shaped digit runs with
   `[removed for your security]` and raises `sensitive_value_detected`.
2. `looksLikeInjection()` discards instruction-shaped content from model prose and from
   extraction text so it can never be stored and re-rendered.

Server logs go through `safelog.redact()`, which strips authorization headers, JWTs, signed
URLs, and keys, truncates long strings, and never receives full request bodies.

## Who may access it

| Role | Access |
|---|---|
| Borrower / co-borrower | Their own application. Each party has separate interview state; one borrower's personal answers are never copied to the other |
| Loan officer (file owner) | Full team review, **masked** secure values only |
| Processor / assistant (`portal_team`) | Same as owner |
| Realtor, escrow, title | **No access.** Structurally excluded — `canSeeFinancials` returns false and the endpoints reject before any read |
| Platform admin | No special application access; admin authority is settings/creation only |

All new tables are server-only: RLS enabled, `anon` and `authenticated` privileges revoked. The
browser cannot read application state directly under any circumstance; every read goes through an
authorized gateway function.

## AI provider exposure

What leaves our infrastructure on an interpret call:

- the borrower's message for that turn
- the active question (prompt, field path, data type, allowed values)
- the allowed field paths for that turn
- a compact list of already-known values for **those paths only**
- interface locale and current month

What never leaves:

- full transcript history (a summarized context is sent instead)
- secure fields — they are filtered out of `allowedPathsForTurn` entirely
- demographic fields — likewise filtered
- any secret, token, key, or internal identifier beyond opaque UUIDs

⚠ **Provider data-handling terms are an owner decision.** Retention, training use, and
sub-processor posture at the configured provider must be reviewed and disclosed before a real
borrower uses this. Provider name and model version are recorded per turn so exposure is
attributable after the fact.

## Retention

⚠ **No retention schedule is implemented.** Nothing in this feature deletes anything on a
schedule. The tables inherit `on delete cascade` from `loan_files`, so deleting a loan file
removes its application, parties, events, projection, turns, secure-field masks, and
attestations. That is the only deletion path that exists today.

Proposed, pending owner and counsel decision:

| Data | Proposed | Rationale |
|---|---|---|
| Attestation records + snapshot | Retain per the lender's record-retention schedule | Evidence of what was attested |
| Field events | Same as the loan file | Audit trail integrity |
| Turn transcripts | Consider a shorter window than field events | Higher volume of incidental personal detail, lower evidentiary value |
| Turn transcripts on abandoned applications | Consider purge after a defined inactivity period | Never became an application |
| Secure-field masks | Same as the loan file | Only last four + digest |

## Export and deletion

- **Export:** the canonical application JSON is produced by the export adapter
  (`ApplicationDestinationAdapter.export()`); the team review endpoint returns the same data in
  a human-readable form.
- **Deletion:** loan-file deletion cascades. ⚠ There is no per-party or per-field erasure
  workflow, and no borrower-initiated deletion request handling. If a right-to-delete regime
  applies, this needs to be designed — the append-only log makes selective erasure a deliberate
  design problem, not an incidental one.

## Incident considerations

- Provider name, model, prompt version, attempt count, and duration are logged per turn without
  borrower content — enough to scope an incident without amplifying it.
- Every turn carries a correlation id, returned to the borrower on a 500 so support can trace it
  without the borrower quoting personal data.
- The keyed digest for secure fields uses `OURMTG_SECURE_FIELD_KEY`. ⚠ Rotating it invalidates
  duplicate detection; there is no re-keying routine. Treat the key as a secret with the same
  handling as the service role.
- Because secure plaintext is not stored, a database compromise does not expose full SSNs or
  account numbers from this feature.
