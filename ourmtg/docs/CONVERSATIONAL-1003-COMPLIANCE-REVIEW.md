# Conversational 1003 — Compliance Review Inventory

**Nothing in this feature has been reviewed by compliance counsel.** This document is the
inventory a reviewer needs, not evidence that a review happened. No regulatory compliance
certification is claimed anywhere in this feature or its documentation.

**Do not enable `CONVERSATIONAL_1003_ENABLED` for a real borrower until the ⚠ items below are
signed off.**

## 1. Controlled questions — every one, with its source

Questions whose wording carries legal meaning are marked `officialTextLocked: true` in the
catalog. The assistant may **explain** them in plain language; it may never restate, soften, or
translate the controlling text. `renderNextQuestion` short-circuits on locked text.

### Declarations (URLA §5a/5b) — 15 questions, verbatim

| Field | URLA | Question |
|---|---|---|
| `occupyAsPrimaryResidence` | 5a.A | Will you occupy the property as your primary residence? |
| `ownershipInterestPastThreeYears` | 5a.B | Have you had an ownership interest in another property in the last three years? |
| `familyRelationshipWithSeller` | 5a.C | Do you have a family relationship or business affiliation with the seller of the property? |
| `borrowingOtherMoney` | 5a.D1 | Are you borrowing any money for this real estate transaction…? |
| `applyingOtherMortgage` | 5a.D2 | Have you or will you be applying for a mortgage loan on another property…? |
| `applyingNewCredit` | 5a.D3 | Have you or will you be applying for any new credit…? |
| `propertySubjectToLien` | 5a.D4 | Will this property be subject to a lien that could take priority…? |
| `coSignerOrGuarantor` | 5b.E | Are you a co-signer or guarantor on any debt or loan…? |
| `outstandingJudgments` | 5b.F | Are there any outstanding judgments against you? |
| `delinquentFederalDebt` | 5b.G | Are you currently delinquent or in default on a Federal debt? |
| `partyToLawsuit` | 5b.H | Are you a party to a lawsuit in which you potentially have any personal financial liability? |
| `conveyedTitleInLieu` | 5b.I | Have you conveyed title to any property in lieu of foreclosure in the past 7 years? |
| `preForeclosureShortSale` | 5b.J | Within the past 7 years, have you completed a pre-foreclosure sale or short sale…? |
| `propertyForeclosed` | 5b.K | Have you had property foreclosed upon in the last 7 years? |
| `declaredBankruptcy` | 5b.L | Have you declared bankruptcy within the past 7 years? |

⚠ **REVIEW ITEM 1:** Confirm each string matches the current URLA revision the lender uses,
character for character. They were transcribed from the 2021 redesign and have not been verified
against the lender's own forms.

### Protected / sensitive characteristic questions

| Field | Wording source | Control |
|---|---|---|
| `citizenshipStatus` | URLA §1a | Locked; asked of every applicant identically |
| `maritalStatus` | URLA §1a | Locked; asked of every applicant identically |
| `demographics.ethnicity` | URLA §7 | Locked, decline permitted, AI inference forbidden |
| `demographics.race` | URLA §7 | Locked, decline permitted, AI inference forbidden |
| `demographics.sex` | URLA §7 | Locked, decline permitted, AI inference forbidden |
| `languagePreference` | LPA | Optional, decline permitted, structurally separate from demographics |

⚠ **REVIEW ITEM 2:** The demographic section uses a single combined explanation ("The government
asks lenders to collect this…"). Confirm the required government-monitoring disclosure wording
and the required collection method (including whether visual observation/surname rules apply when
the borrower declines, and how that must be presented in a remote application).

⚠ **REVIEW ITEM 3:** Confirm support/alimony income questions. The catalog models
`alimony`/`child_support`/`separate_maintenance` as liability types but does **not** ask whether
the borrower *receives* support income. The rule that a borrower need not disclose income they do
not want considered (§6.D) is honored by omission — that may not be the right implementation.

## 2. Fair lending controls implemented

| Requirement | Implementation |
|---|---|
| AI must not infer demographics | `aiInferenceForbidden` in the catalog, enforced in three layers: turn contract rejects (`inference_forbidden`), reducer rejects (`controlled_selection_required`), and the path is excluded from `allowedPathsForTurn` so the model never sees it |
| No inference from name, voice, language, location, surname, accent | Demographic and language fields are `voiceAllowed: false` and controlled-selection only |
| Decline option never hidden | `allowDecline` surfaces "I do not wish to provide this" as a first-class affordance; demographics are never `required`, so declining cannot block completion |
| No discouraging an applicant | System prompt forbids it explicitly; the model cannot mark anything complete, denied, or ineligible |
| No help-quality variation by demographic answer | The planner is deterministic and reads no demographic value; rules never branch on one |
| Same questions for everyone | Controlled templates; the model may re-word only non-locked questions |

⚠ **REVIEW ITEM 4:** Adversarial review of AI-generated re-wordings. `renderNextQuestion` lets
the model re-word non-locked questions. Locked text is protected, but a re-worded *ordinary*
question could still drift. Recommend disabling re-wording entirely for the pilot (leave
`renderNextQuestion` unused — it currently is) or reviewing a sample.

## 3. Attestation and authorizations

- Wording: `attestationText.js`, version `2026.07.attest.draft.1`, `reviewed: false`.
- Records: document key + version, presented timestamp, accepted timestamp, identity, IP, user
  agent, and a full application snapshot.
- It explicitly disclaims approval, pre-approval, verification, underwriting, AUS submission, and
  commitment to lend.
- It explicitly states it is **not** an electronic signature, on screen next to the control.

⚠ **REVIEW ITEM 5:** Approve or replace the attestation wording.
⚠ **REVIEW ITEM 6:** Decide whether intent-to-proceed and credit-pull authorization are required
at this step. They are **not** implemented; if required, model them as separate versioned
documents, not as an extension of this one.
⚠ **REVIEW ITEM 7:** Confirm IP and user-agent capture matches the approved privacy policy.

## 4. Translations

English is the controlling text. Spanish and Russian labels were written for this feature and are
**not reviewed translations**. The attestation panel labels non-English as a courtesy translation
on screen. Locked declaration text is **English only** — it is deliberately not translated,
because §17 forbids the model translating legally controlling disclosures and no reviewed
translation exists.

⚠ **REVIEW ITEM 8:** Have Spanish and Russian reviewed, or restrict the feature to English for
the pilot. A borrower interviewed in Spanish who then sees English-only declarations is a real UX
and possibly compliance problem that this MVP does not solve.

**Owner decision, 2026-07-30 (Anatoliy Kanevsky):** documents are English only. The controlling
declaration and attestation text stays English and is not translated; the interview itself may
continue in Spanish and Russian. This is what the code already does, so no change was required —
it is recorded here so the behavior reads as a decision rather than an oversight.

What this decision does NOT settle: a borrower interviewed in Spanish still reaches an
English-only attestation. The on-screen courtesy-translation label is the only thing currently
mitigating that. If the pilot ever serves a borrower with limited English proficiency, this needs
revisiting — the decision above resolves which text controls, not whether that borrower
understood it.

## 5. Statements the product must never make

Enforced in code and asserted by tests (`report.notMeaning`):

> approved · pre-approved · verified · underwritten · submitted to AUS · cleared to close

`meaning` is always `information_collected_and_attested`. The borrower screen and the team screen
both render the disclaimer. The system prompt forbids the model quoting rates, promising
approval, or asserting eligibility.

## 6. Known compliance gaps in this MVP

| Gap | Status |
|---|---|
| Full URLA/ULAD coverage | **Not claimed.** 15 fields carry no asserted ULAD/MISMO mapping; several sections excluded — see the coverage report |
| Adverse action / ECOA notice timing | Not implemented; out of scope |
| Record retention schedule | Not implemented — see the privacy doc |
| Right-to-delete workflow | Not implemented |
| E-sign (ESIGN/UETA) | Not implemented, and explicitly disclaimed |
| Military / VA questions | Excluded from MVP |
| SCIF / Form 1103 | Language preference modeled; full workflow not built |
| Provider data-handling disclosure | Owner decision, undocumented |

## 7. Sign-off

| Item | Reviewer | Date | Outcome |
|---|---|---|---|
| 1 Declaration wording | | | |
| 2 Demographic disclosure | | | |
| 3 Support income | | | |
| 4 AI re-wording | | | |
| 5 Attestation wording | | | |
| 6 Intent-to-proceed / credit authorization | | | |
| 7 IP + UA capture | | | |
| 8 Translations | | | |
