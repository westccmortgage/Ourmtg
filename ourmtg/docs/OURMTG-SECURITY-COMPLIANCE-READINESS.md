# OurMTG security and compliance readiness

**Status: implementation in progress; not a compliance certification.**
**Catalog:** `2026-08-08.1` · official sources checked 2026-08-08.
**Delta 008:** review source only; not applied to any database.

OurMTG is a private, invite-only mortgage operating workspace. It is not a public application or
lead funnel. A borrower enters through a team-issued invitation, signs in as the verified
recipient, may pause/resume the guided 1003, and sees only requests and information released by
the mortgage team. Automation prepares evidence; licensed people make every decision.

## Controls now enforced in code

- `/plan` no longer starts an anonymous browser-local file. The legacy URL goes to secure sign-in,
  and the public home page states that OurMTG does not accept public applications.
- Signed-upload requests require an allowlisted MIME type and reject dangerous/double extensions.
- Upload completion downloads the private object and checks its actual PDF/JPEG/PNG/HEIC byte
  signature **before** changing document or task state. A renamed payload is refused.
- The malware-scanner boundary is server-only. An infected or failed scan is always refused.
  Pre-underwriting requires an affirmative `clean` result by default, so the model is never the
  first security parser of an uploaded financial document.
- The regulatory catalog is closed and versioned. Unknown loan program or applicability becomes
  a blocker; the system never silently substitutes Conventional or treats unknown as not required.
- The internal pre-underwriting panel displays operational-compliance blockers separately from
  loan readiness. Neither score can express approval, denial, eligibility, or legal compliance.
- Internal users are classified from server-owned file/team/organization relationships. With
  `OURMTG_INTERNAL_AAL2_ENFORCED=true`, the common authenticated gateway refuses their AAL1
  session and the SPA guides them through TOTP enrollment or challenge. Borrowers and transaction
  partners keep their normal verified session. The bootstrap status endpoint returns only role
  class, AAL, and enforcement state; it cannot read a loan or mutate data.

## Internal MFA rollout

The code path is implemented and default-off. Before enabling it outside an isolated branch:

1. Confirm TOTP enrollment, challenge, recovery, staff offboarding, and support procedures in the
   actual Supabase project. Recovery must not be improvised by sharing authenticator secrets.
2. Enroll every active owner, processor, assistant, and organization member. Test expired and
   refreshed sessions, multiple browsers, lost-device recovery, and a borrower account that must
   remain on AAL1.
3. Set `OURMTG_INTERNAL_AAL2_ENFORCED=true` on the server only. No `VITE_` flag authorizes or
   weakens this check.
4. Verify direct function calls: staff AAL1 is refused, staff AAL2 succeeds, borrower AAL1
   succeeds, and a database/classification failure refuses access.
5. Record the acceptance evidence, then set `OURMTG_INTERNAL_AAL2_ACCEPTED=true`. The internal
   pre-underwriting panel requires both flags before this blocker clears. Code existence or an
   enforcement switch alone is not a Safeguards Rule compliance determination.

## Scanner configuration

Production configuration is intentionally unusable until a scanner is selected:

| Variable | Purpose |
|---|---|
| `OURMTG_DOCUMENT_SCAN_PROVIDER=http` | Select the reviewed server-to-server scanner adapter |
| `OURMTG_DOCUMENT_SCAN_URL` | HTTPS scanner endpoint |
| `OURMTG_DOCUMENT_SCAN_TOKEN` | Server-only bearer credential |
| `DOCUMENT_UPLOAD_REQUIRE_CLEAN_SCAN=true` | Require `clean` before borrower upload finalization |
| `PRE_UNDERWRITING_REQUIRE_CLEAN_SCAN` | Defaults to required; only literal `false` is a local-development exception |

The request contains only `{ bucket, path }`; the scanner must use its own narrowly scoped private
storage access. `mock` is refused unless `OURMTG_ALLOW_MOCK_SCAN=true` and is for tests only.

## Versioned sources in the catalog

- URLA/Form 1003 and SCIF/Form 1103: Fannie Mae/Freddie Mac source and ULAD guidance.
- FHA: current HUD forms catalog entry for HUD-92900-A.
- USDA: Handbook 3555, RD 3555-21, Attachment 15-A checklist, and income resources.
- VA: current VA Pamphlet 26-7 plus effective circulars; a compliance review must lock chapter
  revisions rather than relying on a stale form number.
- ECOA/Regulation B: incomplete-application notifications and 25-month record preservation.
- TRID: the six-piece application trigger and Loan Estimate handoff.
- Regulation P and the FTC Safeguards Rule: privacy, vendor/data handling, access controls,
  encryption, MFA, logging, incident response, and service-provider oversight.

Sources being present in code is not enough. `OURMTG_REGULATORY_CATALOG_APPROVED=true` may be set
only after compliance has reviewed the exact catalog revision and applicability logic.

## Blocking items before a real borrower pilot

1. Complete live isolated-project acceptance of internal-user MFA/AAL2, enroll staff, document
   recovery/offboarding, and enable the server flag. Stubbed tests do not complete this control.
2. Select, contract, configure, and test a production malware scanner; enable clean-scan upload
   enforcement.
3. Complete URLA/ULAD coverage, including currently unmapped fields and the SCIF workflow.
4. Implement the six-piece TRID application clock/handoff without conditioning the Loan Estimate
   on verification documents.
5. Implement Regulation B incomplete/application notification timers and immutable delivery
   evidence. A reminder/task is not a statutory notice.
6. Obtain review of the 1003 attestation, credit authorization, translations, privacy notice,
   model/provider disclosure, and service-provider data terms.
7. Approve retention and legal-hold rules. Regulation B commonly requires preserving application
   and evaluation records for 25 months, but counsel/Compliance must define the full schedule and
   interactions with state, investor, litigation, and privacy duties.
8. Decide and implement the approved vault/LOS handoff for full SSN/account identifiers. OurMTG
   currently keeps last-four plus a keyed digest; plaintext must not be added to application tables.
9. Apply delta 008 only to an isolated Supabase branch, then verify RLS, privileges, immutable
   triggers, restore, legal hold, and rollback behavior before any production authorization.

## Evidence ledger (delta 008)

The proposed server-only tables retain immutable evidence for document byte/scan assessments,
approved catalog revisions, per-file compliance snapshots, and record-retention/legal-hold events.
All have RLS enabled, browser roles revoked, and update/delete refused. This ledger is deliberately
separate from a loan decision: it proves what controls and sources were in force, not whether a
borrower qualified.

## Product invariant

The borrower may leave and resume at any time. The application may not be represented as complete
while required facts, confirmations, documents, controlled texts, or compliance controls are
missing. `null/unknown` remains visible with a reason; it is never converted to a plausible answer.
