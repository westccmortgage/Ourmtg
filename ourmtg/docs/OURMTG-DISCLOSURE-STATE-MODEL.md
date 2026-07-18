# OURMTG — Disclosure State Model (§9)

Canonical source: `src/domain/services/disclosureService.js` + `lifecycles.js` (`DISCLOSURE_TRANSITIONS`).
Tested in `tests/disclosure.test.mjs`. Flag-gated (`flags.disclosureTracking`, default OFF).
**Tracking only — NOT an e-sign integration.** No provider is integrated; nothing is sent.

## States (11) — kept strictly DISTINCT (sent ≠ delivered ≠ opened ≠ completed)
`prepared → sent → provider_accepted → delivered → bounced → opened → viewed → partially_signed → completed → expired → resend_required`. Terminal: `completed`.

## Transition graph
| From | Allowed next |
|---|---|
| prepared | sent |
| sent | provider_accepted, bounced, expired, resend_required |
| provider_accepted | delivered, bounced, expired |
| delivered | opened, expired, resend_required |
| bounced | resend_required |
| opened | viewed, partially_signed, completed, expired |
| viewed | partially_signed, completed, expired |
| partially_signed | completed, expired, resend_required |
| completed | — |
| expired | resend_required |
| resend_required | sent |

## Distinctness (tested — states must not be collapsed)
- `sent` ≠ `delivered` ≠ `opened` ≠ `completed` at both the predicate level (`isSent/isDelivered/isOpened/isCompleted`) and the label level (`TEAM_STATUS_LABEL`).
- Skipping is rejected: `prepared → completed` and `sent → opened` are `invalid_transition`.

## Labels
- **Team-facing** (`TEAM_STATUS_LABEL`): exact per-state — "Sent to borrower", "Delivered to borrower", "Opened by borrower", "Completed (all signed)", etc.
- **Borrower-facing** (`BORROWER_STATUS_LABEL`): plainer wording, still distinct where it matters.
- Borrower explanation (non-obligating): *"These are your initial mortgage disclosures. They contain estimated terms, costs, and required notices. Signing them does not obligate you to complete the loan."*

Draft persistence: `disclosure_packages` (guarded draft) records `status`, `sent_at`, `delivered_at`, `opened_at`, `partially_signed_at`, `completed_at`, `expired_at`, `resend_required`, provider fields.
