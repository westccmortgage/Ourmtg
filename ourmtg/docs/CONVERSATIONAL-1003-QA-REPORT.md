# Conversational 1003 — QA Report

Run from `ourmtg/` on branch `claude/ourmtg-conversational-1003-mvp`.

## Commands and results

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | Installed from lockfile. **No dependencies added or changed.** |
| `npm run check` | 0 | `ok` — `node --check` on all 31 function + lib modules |
| `npm run test:security` | 0 | **227 tests, 227 pass, 0 fail** (pre-existing suite, no regressions) |
| `npm run test:domain` | 0 | **5 tests, 5 pass, 0 fail** (pre-existing suite, no regressions) |
| `npm run test:c1003` | 0 | **43 tests, 43 pass, 0 fail** (new) |
| `npm test` | 0 | **275 tests, 275 pass, 0 fail** (all suites) |
| `npm run build` | 0 | Built in ~3s. `index.js` 622.07 kB (gzip 191 kB), `index.css` 22.85 kB (gzip 5.68 kB) |
| `npm audit` | — | 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing on `main`**; verified identical before and after this change |

### New test scripts

- `npm run test:c1003` — the feature's own suite
- `npm test` now also runs `src/features/conversational-1003/*.test.js`

## Test breakdown (43 new)

| File | Tests | Covers |
|---|---|---|
| `scenarios.test.js` | 23 | The 20 required borrower scenarios + 3 supporting units |
| `contract.test.js` | 18 | Catalog, rules, turn contract, prompt, confirmation policy, attestation invariants |
| `e2e.test.js` | 2 | Full application to attestation; planner-loop safety |

## The 20 required scenarios (§28)

| # | Scenario | Status | Key assertion |
|---|---|---|---|
| 1 | Employment-duration misunderstanding | ✅ | Income kept as **estimated candidate**; start date still `missing`; recovery is blame-free and re-asks the same field |
| 2 | Multiple facts in one sentence | ✅ | All 6 facts captured; next question is the bonus **frequency**; nothing captured is re-asked |
| 3 | Insufficient employment history | ✅ | 10-month job triggers `history_backfill`; new record gets a new index; requirement clears once 24 months are covered |
| 4 | Self-employed borrower | ✅ | Ownership %, business start date, and owner flag are separate required fields; a W-2 job requires none of them |
| 5 | Monthly vs annual | ✅ | "96,000" stored; frequency **not guessed**; no monthly equivalent derived; asks the period |
| 6 | Approximate income | ✅ | `estimated: true`, display `~$8,000`; confirming resolves it **without** erasing the estimate flag |
| 7 | Multiple residences | ✅ | Backfill requested; a 5-month hole reported as `history_gap` |
| 8 | Multiple assets | ✅ | Two distinct records; only the hedged one is estimated |
| 9 | Co-borrower separation | ✅ | Party 0 and party 1 hold independent values; shared loan facts not duplicated |
| 10 | Borrower correction | ✅ | New value requires re-confirmation; old value retained as `superseded` |
| 11 | Allowed refusal | ✅ | Model extraction rejected `inference_forbidden`; conversational write rejected; controlled decline recorded; demographics never required |
| 12 | Secure field | ✅ | SSN scrubbed from transcript; `sensitive_value_detected` raised; path absent from the model's allowed set; only a mask stored |
| 13 | Out-of-order property info | ✅ | Purchase price captured mid-answer; appears on the confirmation card; confirms cleanly |
| 14 | Contradiction | ✅ | Both values retained as `conflicting`; conflict outranks all other questions; cannot be confirmed away |
| 15 | Skip and resume | ✅ | Skip defers without completing; replaying the event log reproduces identical state and percent |
| 16 | Language | ✅ | es/ru amounts and months parse identically; employer names stored **verbatim**, never translated |
| 17 | Duplicate request | ✅ | Re-recording an identical value is a no-op; one event, not two |
| 18 | Model failure | ✅ | Answer preserved; deterministic next question still produced; nothing fabricated |
| 19 | Prompt injection | ✅ | Injected prose never rendered; both extractions discarded; application stays incomplete; `canAttest` false |
| 20 | Cross-file authorization | ✅ | Engine state is scoped to its own application id |

## End-to-end acceptance (§29)

`e2e.test.js` drives a fictional borrower through the **entire** application using the real
planner, reducer, rules, and completeness engine — 40+ questions, from the first question to
attestation. It asserts:

- the interview **terminates** (no unreachable field, no infinite loop)
- no field is asked more than twice
- `openFields`, `structural`, and `conflicts` all reach zero
- `percent` reaches 100 **only** then; `canAttest` becomes true
- both borrower and team review projections render and agree
- a secure value is masked in **both** views

## What was exercised live

The borrower UI was built with the flag on, served, and driven with a real browser
(Chromium via Playwright) against the real components. The screenshots in the delivery show the
flagship §0 behavior end-to-end: the borrower answers with two-year income, and the assistant
saves it as an estimated income candidate, explains the difference, and re-asks the start date.

Network responses in that run were **generated by the real engine** and served to the page; the
database and the live AI provider were not involved.

## What is mocked, and what that means

| Component | State |
|---|---|
| AI provider (tests) | Deterministic `mockProvider` — parses with the same normalizers, never guesses |
| AI provider (production) | Live `fetch` adapter written; **not exercised against the real API** (no key in this environment) |
| Database | **Not exercised.** Migration 003 is written but not applied; no live read/write has been performed |
| Voice transcription | Browser `SpeechRecognition` only; no server provider exists |
| LOS / AUS export | Null adapter that validates, previews, and **refuses** to export |

## Not executed

- **Any database operation.** No migration applied; the repo layer, all six endpoints, RLS, and
  idempotency-at-the-database-level are verified by code review and import checks only.
- **A live provider call.** No `ANTHROPIC_API_KEY` in this environment.
- **A real borrower session** end to end through HTTP.
- **Multi-party (co-borrower) flow through the endpoints** — engine-level only.
- **Automated a11y and cross-browser testing.**

## Requires environment configuration before it can run

`CONVERSATIONAL_1003_ENABLED`, `VITE_FF_CONVERSATIONAL_1003`, `ANTHROPIC_API_KEY`,
`OURMTG_SECURE_FIELD_KEY`, and migration `003_conversational_1003.sql` applied to an isolated
database. See `CONVERSATIONAL-1003-DEPLOYMENT-REQUIREMENTS.md`.

## Defects found and fixed during this work

| Defect | Where | Fix |
|---|---|---|
| Cyrillic frequency terms never matched (`\b` is ASCII-only in JS) | `normalization.js` | Unicode-aware `\p{L}` boundaries |
| Secure fields could not be written even by the secure control (type normalizers reject everything) | `applicationReducer.js` | Mask-only write path that also rejects anything containing a long digit run |
| History backfill fired before existing records were filled in — asked "where did you work before that?" while the current job's start date was blank | `completenessEngine.js` | `collectHistory` returns null until existing records are complete |
| Planner re-asked a field holding an unconfirmed candidate — an infinite loop on any high-impact field | `questionPlanner.js` | Candidates route to a confirmation step instead of being re-asked |
| "I make 96,000" was accepted without a period | `misunderstanding.js` | Ambiguity detection now fires even when the asked field *was* answered |
| Language preference was voice-inferable, contradicting §26 | `applicationCatalog.js` | `voiceAllowed: false` |
| Confirmation card and acknowledgement used question text ("How much is it?: $160,000") | `applicationCatalog.js`, `confirmationPolicy.js`, `misunderstanding.js` | Short noun labels via `chipLabel` |
| Duplicate EN/ES/RU switcher collided with the site header | `ApplicationAssistant.jsx` | Reuse the app's existing `useLang()` context |
| Non-existent `checkRateLimit` import; `sharedLimiter` would have clobbered lead-submit's limits | `application-turn.mjs` | Dedicated `createRateLimiter` instance |

The first six were found **by the tests**, not by inspection.
