# Conversational 1003 — Conversation Protocol

How one borrower turn is processed, what the AI is asked for, and what happens when it
misbehaves or is unavailable.

## The turn contract

Every interpretation must satisfy this shape. Anything else is discarded — the borrower's words
are already stored by then, so a bad response costs a retry, never an answer.

```jsonc
{
  "answerRelevance": "direct | partial | unrelated | unclear",   // required
  "misunderstandingDetected": true,
  "misunderstandingKind": "duration_vs_amount",                  // from a closed list
  "plainLanguageExplanation": "...",
  "extractions": [                                               // required (may be empty)
    {
      "fieldPath": "parties[0].employment[0].startDate",         // MUST be in the catalog
      "rawText": "I started sometime in March 2023",
      "normalizedCandidate": "2023-03",                          // re-parsed server-side anyway
      "confidence": 0.94,
      "requiresClarification": false,
      "requiresConfirmation": true,
      "reason": "..."
    }
  ],
  "unmappedFacts": [],
  "contradictions": [],
  "clarificationTargets": [],
  "safetyFlags": []
}
```

### What is rejected, and why

| Rejection | Reason |
|---|---|
| `unknown_field_path` | The model invented a path. The catalog is the allowlist. |
| `secure_entry_required` | An SSN/account field. Only the masked control may write these. |
| `inference_forbidden` | A demographic or language-preference field. Never model-supplied. |
| `injection_in_raw_text` / `injection_in_candidate` | Instruction-shaped content carried as data. |
| `failed_normalization` | Impossible date, malformed amount, unknown enum or frequency. |
| `negative_not_allowed` | A negative value where negatives are impossible. |
| `candidate_not_scalar` | An object where a scalar belongs. |
| `empty_candidate` | Nothing proposed. |

The model's own `normalizedCandidate` is treated as a **proposal**: `normalization.js` re-parses
it. The model never performs date math, unit conversion, or arithmetic that reaches storage.

### Structured output

The catalog schema is projected for the provider by `apiJsonSchema()`, which strips keywords
structured outputs reject (`maxLength`, `maxItems`, `minimum`, `maximum`, …) and forces
`additionalProperties: false`. Those constraints are still enforced — locally, by the validator.
One schema, two projections, no drift (asserted by a contract test).

## Non-answer intents

Available at **every** question (§11):

| Intent | Behavior |
|---|---|
| `why_asking` | Show the field's plain-language purpose. Question stays. |
| `do_not_understand` | Show the purpose, increment the confusion counter, escalate presentation. |
| `do_not_know` | Defer. Not a refusal, not an answer — the field stays open, no pressure. |
| `skip_for_now` | Defer where allowed; cleared at review so nothing stays hidden. |
| `show_saved` | Open the review view. |
| `correct_something` | Next extraction is treated as a correction (supersedes rather than conflicts). |
| `talk_to_team` | Hand off; question stays. |
| `decline_to_provide` | Recorded as `declined_allowed` **only** where the catalog permits refusal; otherwise silently deferred with no repeated pressure. |

`do_not_know` and `decline_to_provide` are detected deterministically from the borrower's own
words in all three languages when the client does not send an explicit intent — uncertainty and
refusal are different states and must never be conflated (§10).

## Misunderstanding recovery

Detection is deterministic: it compares **what was asked** against **what was actually
extracted**. The model's own `misunderstandingDetected` is a hint only.

Recovery always follows this order and never uses the words *wrong*, *incorrect*, or *invalid*:

1. acknowledge what was saved, naming it (`"$160,000 as possible income amount"`)
2. explain the concept in plain language
3. give a concrete example when one helps
4. ask exactly one precise follow-up

Worked example (the case the product exists for):

> **Asked:** What month and year did you start there?
> **Borrower:** I made about $160,000 during those two years
> **Assistant:** Thank you — I saved ~$160,000 as possible income amount. For this question I
> need a date — the month and year you began — rather than an amount. For example: "March 2023"
> or "03/2023". What month and year did you start there?

Result: income stored as an **estimated candidate**, employment start date still `missing`,
next question is the same field. Asserted by scenario test 1.

### Recognized categories

`duration_vs_amount`, `start_date_vs_years_employed`, `monthly_vs_annual`,
`asset_balance_vs_income`, `employer_vs_occupation`, `value_vs_mortgage_balance`,
`loan_amount_vs_purchase_price`, `rent_vs_property_tax`, `current_vs_mailing_address`,
`gross_vs_net_income`, `unrelated_but_useful`.

Two fire even when the asked field *was* answered, because the answer is unusable alone:
`monthly_vs_annual` ("I make 96,000" — period unknown) and `gross_vs_net_income` ("take-home").

## Non-linear capture

The model is offered the asked field, its sibling record, and the next open slot of every group
(`allowedPathsForTurn`) — not the whole catalog. That is enough for a borrower who volunteers
four facts in one sentence, without opening 109 write targets every turn.

## Confirmation policy

Captured values appear immediately as chips. Only **high-impact** values interrupt with a
confirmation card: identity, dates, amounts and frequencies, balances, property value, purchase
price, loan amount, occupancy, ownership, liabilities, declarations, REO, and anything the
catalog marks `confirmRequired` or `highImpact`. One card per turn, three options —
**Correct / Change it / I'm not sure** — and "I'm not sure" is never omitted.

## Loop safety and escalation

Every question carries a stable id, an attempt count, and a confusion count.

| Level | Presentation |
|---|---|
| 0 `normal` | Standard wording |
| 1 `simplified` | Simpler wording plus the explanation |
| 2 `examples` | Worked examples / selectable choices |
| 3+ `assisted` | Offer structured input and the loan team |

A field holding an unconfirmed candidate is **never re-asked** — it routes to the confirmation
step instead. That distinction is what prevents the interview from looping forever on a
high-impact field; both e2e tests assert no field is asked more than twice.

## Provider failure

| Failure | Behavior |
|---|---|
| Timeout | One bounded retry, then deterministic fallback |
| 429 / 5xx | Retryable; bounded |
| 4xx | Not retried (our bug) |
| Safety refusal (`stop_reason: "refusal"`) | Logged with category, treated as "no interpretation" |
| Truncated output | Treated as failure, not as partial data |
| Non-JSON / contract failure | Discarded entirely |
| No provider configured | Deterministic path only |

In all cases: the turn is already persisted, the planner still produces a question, and the
borrower sees *"I saved what you wrote, but I couldn't read it just now. Let's keep going — you
don't need to type it again."* Turn state becomes `failed_safe`.

## Idempotency

The client mints one key per logical action and **reuses it across retries**. The server claims
it before interpreting. Same key + same payload → the original result replays. Same key +
different payload → `409 idempotency_conflict`. Engine-level, re-recording an identical value is
a no-op, so a replay cannot double-write even if the claim is bypassed.

## Voice

Text is always available. Voice uses the browser's own `SpeechRecognition` where present:
capability detection, explicit recording state, stop and cancel, and a transcript the borrower
edits before submission. No audio is recorded or uploaded — the browser returns text.

**There is no approved server-side transcription provider configured.** The provider interface
exists; a live adapter does not. This is stated in the UI rather than faked. Voice is refused
outright on secure fields.
