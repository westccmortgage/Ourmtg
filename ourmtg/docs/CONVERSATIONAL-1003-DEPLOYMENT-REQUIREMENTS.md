# Conversational 1003 — Deployment Requirements

**Current state: NOT DEPLOYED. No migrations applied. Flag default OFF.**
Nothing in this document has been executed against production.

## 1. Feature flags

| Variable | Where | Default | Effect |
|---|---|---|---|
| `CONVERSATIONAL_1003_ENABLED` | Server (Netlify env) | `false` | **Authorizes the feature.** Every `application-*` function returns 404 unless this is `true` or `1`. |
| `VITE_FF_CONVERSATIONAL_1003` | Client (build-time) | `false` | Mounts the routes. **Presentation only — authorizes nothing.** |

Both are needed for a usable feature. The client flag alone exposes nothing; the server flag
alone means the API works but no UI is routed. Anything other than `"1"`/`"true"` is OFF.

## 2. Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CONVERSATIONAL_1003_ENABLED` | yes | Server feature gate |
| `ANTHROPIC_API_KEY` | yes (live) | Provider key. **Server-side only — never a `VITE_` variable.** |
| `CONVERSATIONAL_1003_PROVIDER` | no | `anthropic` (default) or `mock` |
| `CONVERSATIONAL_1003_MODEL` | no | Defaults to `claude-opus-5` |
| `CONVERSATIONAL_1003_EFFORT` | no | Defaults to `low` — correct for structured extraction |
| `CONVERSATIONAL_1003_ALLOW_MOCK` | no | Must be `true` for the mock to be selectable. **Never set in production.** |
| `OURMTG_SECURE_FIELD_KEY` | yes | HMAC key for the secure-field digest. Falls back to `OURMTG_FINGERPRINT_SALT`; set it explicitly. Treat like the service role key. |
| `ANTHROPIC_BASE_URL` | no | Override for testing |

### Running without a provider key (basic mode)

The feature is usable before an `ANTHROPIC_API_KEY` exists, but the two modes are genuinely
different and should not be confused:

| | Basic mode (no key) | Full mode (key configured) |
|---|---|---|
| Borrower answers the question asked | ✅ captured — deterministic parsing of amounts, dates, yes/no, choices, and an income period stated alongside an amount | ✅ captured |
| Borrower answers a *different* question | ❌ not captured; the same question is asked again | ✅ captured, explained, and the missing piece re-asked |
| Several facts in one sentence | ❌ only the asked field | ✅ all of them |
| Free-form phrasing, es/ru narrative | ❌ only what parses unambiguously | ✅ interpreted |

Basic mode never invents a value: if the text does not parse cleanly as the asked field's type,
nothing is stored and the question is repeated. Secure and demographic fields are never written
this way. The borrower is told plainly ("the assistant is running in basic mode right now"), and
the turn is recorded with `error_code = deterministic_fallback` so the mode is visible after the
fact.

**The product the brief describes — talk naturally and it fills in what is needed — requires the
key.** Basic mode is a floor, not the feature.

### Provider notes

The live adapter uses `fetch` against the Messages API — **no vendor SDK, no new dependency.**
It deliberately does not send `temperature`/`top_p`/`top_k` (rejected by this model family) and
does not disable thinking (disabling is effort-capped and associated with tool-call and tag
leakage); depth is controlled with `effort` instead. Structured output uses
`output_config.format` with the projected schema. A safety-classifier refusal
(`stop_reason: "refusal"`) is handled as "no interpretation available", not as an exception.

## 3. Database migration — NOT APPLIED

`supabase/delta/003_conversational_1003.sql` creates seven tables:

`mortgage_applications`, `application_parties`, `application_field_events`,
`application_field_state`, `application_turns`, `application_secure_fields`,
`application_attestations`

All are server-only: RLS enabled, `anon`/`authenticated` privileges revoked — the same posture as
`statement_income_analyses`. The script refuses to run against a database that lacks
`loan_files`/`portal_access`, and ends with a verification query mirroring delta 002's.

### Rehearsed against a real Postgres

The full chain (baseline `001` → delta `001` → `002` → `003`) has been applied to a throwaway
Postgres 16 and verified: 7 tables, RLS on, zero browser privileges, idempotent re-run, guard
clause fires on a foreign database, every check and unique constraint rejects bad data, cascade
delete works, and the rollback is clean — **23/23 checks pass.**

Re-run it any time (it never touches a real project):

```bash
./supabase/rehearsal/run-rehearsal.sh
```

This does **not** replace applying it to an isolated Supabase project: RLS under a real
`anon`/`authenticated` JWT, GoTrue, and the storage API are Supabase-specific and still unproven.

**Apply order:** after `supabase/delta/002_statement_income_analysis.sql`.
**Authorization required:** owner approval, against an isolated database first. Do not apply to
production as part of this change.

Rollback: `drop table` in reverse dependency order (attestations, secure_fields, turns,
field_state, field_events, parties, applications). No existing table is altered, so rollback does
not touch anything that shipped before this feature.

## 4. Deployment risks

| Risk | Severity | Mitigation |
|---|---|---|
| Provider cost is unbounded per borrower | Medium | 60 turns/min/user limiter; `effort: low`; minimum-context prompts. **No per-application spend cap exists** — add one before a wide rollout |
| Provider outage | Low | Deterministic fallback; the answer is never lost; borrower sees a plain notice |
| Secure-field plaintext is not stored | **Decision needed** | If the lender requires full SSN for submission, a KMS/encryption design is required. Do **not** add a plaintext column |
| No approved transcription provider | Medium | Voice is browser-only and says so; text always available |
| Translations unreviewed | **Blocker for es/ru pilot** | Restrict the pilot to English, or get translations reviewed |
| Attestation wording is draft | **Blocker** | Counsel sign-off required |
| No retention schedule | Medium | Documented; owner decision |
| Bundle size grew | Low | 622 kB (from ~560 kB). Under the flag; code-split if it matters |
| Team review loads all turns | Low | Capped at 100 turns per request |

## 5. Pre-pilot checklist

Before a real borrower touches this:

- [ ] Compliance sign-off on all 8 ⚠ items in `CONVERSATIONAL-1003-COMPLIANCE-REVIEW.md`
- [x] ~~Rehearse the migration chain against a real Postgres~~ — done, 23/23 (`run-rehearsal.sh`)
- [ ] Apply migration 003 to an isolated **Supabase** project and run its verification query
- [ ] Configure `ANTHROPIC_API_KEY` and `OURMTG_SECURE_FIELD_KEY` in Netlify
- [ ] Confirm `CONVERSATIONAL_1003_ALLOW_MOCK` is **unset** in production
- [ ] End-to-end test against the isolated database with a fictional borrower
- [ ] Decide the secure-field storage question (mask-only vs encrypted plaintext)
- [ ] Decide retention for turn transcripts
- [ ] Confirm provider data-handling terms and disclose as required
- [ ] Decide whether the pilot is English-only
- [ ] Add a per-application provider spend cap
- [ ] Confirm the borrower knows they are talking to an AI assistant (disclosure placement)

## 6. Explicitly NOT part of this deployment

Underwriting or eligibility decisions · automated adverse action · income calculation approval ·
automated condition clearance · credit authorization beyond the existing workflow · DU, LPA, or
Arive submission · legal e-signature · bank credential collection · any credit, document, or
government verification integration · production migration · production rollout.
