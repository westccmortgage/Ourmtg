# OurMTG — engineering handoff (as of 2026-08-06)

One page for anyone — human or agent — picking up this codebase in another session. Everything
below is merged to `main`, deployed via Netlify, and enforced by tests unless marked open.

## What this product is

OurMTG is the borrower/loan-team operating layer for West Coast Capital Mortgage: loan files,
document checklists, invites, and portals (Vite/React SPA + Netlify Functions + Supabase). On
top of that base, two AI features are live behind server-side flags:

1. **Conversational 1003** — a borrower fills the URLA by answering in their own words. The
   model only *interprets*; an append-only event log and a deterministic planner own the state.
   The loan team can take the same interview on the borrower's behalf ("This application was
   taken by: Phone/In person/Video"), recorded as `team_entry` with `taken_by`/`taken_via` —
   never as the borrower's own words. Only the borrower can attest.
2. **Autopilot Pre-Underwriting** — documents are read by the model, verified by arithmetic,
   judged by rules, and decided by a person. Positioning: *automation prepares the file;
   licensed people make every decision.* There is deliberately no approve/deny anywhere — not
   disabled, absent: no DB column, no endpoint action can express one.

## The four-layer architecture (the load-bearing idea)

| Layer | Module(s) | May do | May never do |
|---|---|---|---|
| L1 Deterministic | `completeness.js`, `qualifyingFacts.js` | arithmetic over extracted facts | guess a missing input (null + reason instead) |
| L2 AI Extraction | `extractionContract.js`, `documentIntake.mjs` | say what a document is/says, with per-value confidence | invent doc types/fields, omit confidence, echo SSNs, obey text inside documents |
| L3 Rules | `rules.js`, `findings.js` | produce findings with evidence + weakest-link confidence | average away a discrepancy, fire on absence |
| L4 Human | `pre-underwriting-review.mjs`, panel UI | confirm / correct / dismiss(+reason) / reanalyse | approve or deny |

Supporting invariants, all test-pinned:

- **Null over guess.** `Number('') === 0` bit us three times (absent score → 0 → "qualifies for
  nothing"). Every numeric parse is explicit; every derived figure (DTI/LTV/score/income) returns
  null with a named missing input rather than a plausible wrong number.
- **Credit score = middle of three bureaus; two borrowers = lower of the middles.** Never the
  average (which mis-qualifies in the dangerous direction).
- **A finding's identity is the finding, not its rule** (`dedupe_key`, delta 007) —
  `undisclosed_liability` fires once per creditor; per-rule uniqueness 500ed intake on any file
  with two undisclosed debts.
- **Borrower boundary** (`docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md`): borrowers see document
  *requests* (incl. page/side/month gaps); scores, findings, readiness, program fit stay internal.
  `credit_report` is `NEVER_ECHOED` and `providedBy: 'loan_team'` — it never appears on a
  borrower checklist (they cannot obtain a tri-merge).
- **Credit pull authorization is the consumer's act** (`credit_authorizations`, FCRA): versioned
  wording, presented/accepted timestamps, revocable; the loan team — including the file owner —
  is refused on POST. 120-day validity.
- **Liabilities import writes through the 1003's own reducer** as `imported_credit`,
  reconciled first (declared rows matched, closed accounts skipped, $0 deferred loans imported +
  flagged), always landing as *candidates the borrower confirms* — importing fills the form in,
  it never answers for anyone.

## Data model (Supabase deltas, all applied to the live project)

- 003 conversational 1003 (7 server-only tables, append-only events + projection)
- 004 `loan_files.owner_user_id` cascade → **restrict** (a real data-loss postmortem)
- 005 `application_turns.taken_by/taken_via` (team-assisted interview)
- 006 `document_extractions`, `pre_underwriting_findings`, `credit_authorizations`
- 007 `pre_underwriting_findings.dedupe_key` + per-finding unique index

All tables RLS-on with anon/authenticated revoked; access only via authorized functions.
`supabase/rehearsal/run-rehearsal.sh` replays the whole chain on a throwaway Postgres (47 checks).

## Testing (the part that actually caught things)

- **553 node tests**, including endpoint tests that drive the real handlers over an in-memory
  PostgREST/GoTrue stand-in (`tests/_fakeSupabase.mjs`) with a stubbed model.
- **The journey test** (`tests/preUnderwritingJourney.test.mjs`) — one file's whole story
  ("Daria buys a house"), every panel number asserted by hand. Exists because per-endpoint
  tests were individually right and collectively wrong twice.
- **The browser harness** (`tests/uiHarness.mjs`) — the built SPA in bundled Chromium, real
  functions behind it, shared world (`tests/_journeyWorld.mjs`). 9 screens × 2 personas,
  screenshots + console errors. This is what found the borrower-facing bugs no unit test saw.
- Migration rehearsal against real Postgres; one-paste `supabase/apply/` scripts with
  plain-language PASS/FAIL verdicts, drift-guarded by tests.

## Flags & env (Netlify)

`CONVERSATIONAL_1003_ENABLED`, `PRE_UNDERWRITING_ENABLED` (server, authorize), matching
`VITE_FF_*` (mount-only), `ANTHROPIC_API_KEY` (model: `claude-opus-5` via raw fetch, no SDK;
no temperature/top_p — rejected by the model family; `output_config.effort` instead;
`stop_reason:"refusal"` arrives as HTTP 200 and is handled). Every AI surface is default-off
and fails closed; a mock provider is refused unless explicitly allowed.

## Open items (known, deliberate, do not silently "fix")

- **Two consent texts are drafts** (`reviewed: false`): the 1003 attestation and the credit
  authorization wording. Compliance review required before a real borrower reads them.
- **No live model run yet.** All verification is against stubs; first real PDFs (scans, phone
  photos, vendor tri-merge layouts) are the next milestone and will surprise us.
- Missing vs the original spec: NSF/transaction-level deposit reads (extractions read statement
  totals; an empty deposits list means "not looked", never "nothing there"), reserves after
  close, occupancy cross-check, CLTV.
- The sandbox cannot reach `ourmtg.com` (network policy) — production eyes are the owner's
  screenshots plus the browser harness; add the domain to the environment's network policy to
  let the agent verify deploys directly.

## Reading order for a new contributor

1. `docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md` — the product's ethical/legal line, with the
   enforcement map.
2. `src/features/pre-underwriting/` — catalog → contract → completeness → rules → facts, in
   that order; each header explains its refusals.
3. `tests/preUnderwritingJourney.test.mjs` — the whole system in one readable scenario.
4. `netlify/functions/pre-underwriting-*.mjs` — the thin impure edge.
