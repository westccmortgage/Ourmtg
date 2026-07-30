# Conversational 1003 — Conditional Rules

Rules version `2026.07.1003.1` · defined in `src/features/conversational-1003/applicationRules.js`
· every rule unit-tested in `contract.test.js` and exercised by `scenarios.test.js`.

## Contract

A rule is a pure function of application state returning exactly one of:

| Return | Meaning |
|---|---|
| `true` | The field **is** required right now |
| `false` | Not required *yet* — the trigger answer is still unknown (stays open) |
| `'n/a'` | Structurally not applicable; resolves as `not_applicable` |

The distinction between `false` and `'n/a'` is load-bearing: `false` means *keep asking around
it*, `'n/a'` means *this can never apply, stop counting it*. Conflating them either strands the
borrower or lets an incomplete application look complete.

**Unknown rule ids fail closed** (not required) and are caught by a contract test that asserts
every `requiredWhen` in the catalog names a real rule — a typo can never silently make a field
mandatory or optional.

## The rules

### Identity
| Rule | Fires when |
|---|---|
| `hasDependents` | `dependentsCount > 0` → ages required; `= 0` → n/a |
| `alternateNamesApply` | Always optional; never blocks completeness |

### Residence
| Rule | Fires when |
|---|---|
| `residenceIsPrevious` | `isCurrent = false` → move-out date required; current → n/a |
| `housingExpenseApplies` | `occupancyBasis` is own/rent → payment required; `live_rent_free` → n/a |
| `mailingAddressDiffers` | `mailingAddressSameAsCurrent = false` → mailing address required |

### Employment
| Rule | Fires when |
|---|---|
| `employmentIsPrevious` | `isCurrent = false` → end date required |
| `employmentIsSelfEmployed` | `employmentType = self_employed` → ownership %, business start date, owner flag |
| `employerAddressRequired` | `isCurrent = true` → employer address required (verification of employment) |

### Income
| Rule | Fires when |
|---|---|
| `incomeIsHourly` | `frequency = hourly` → hours per week required (no 40-hour assumption is ever made) |
| `incomeIsOther` | `incomeType = other` → description required |
| `incomeIsEmploymentLinked` | Employment-linked income **and more than one employer** → which job |

### Loan and property
| Rule | Fires when |
|---|---|
| `loanIsPurchase` | `purpose = purchase` → price, down payment, source, under-contract |
| `loanIsRefinance` | `purpose = refinance` → estimated value, refi purpose, existing balance |
| `refinanceIsCashOut` | `refinancePurpose = cash_out` → cash-out amount |
| `propertyAddressKnown` | Refinance → always; purchase → unless not yet under contract (a borrower who hasn't chosen a home is **not** a gap) |
| `titleVestingApplies` | Never blocks the borrower; escrow/title confirm wording |

### Assets
| Rule | Fires when |
|---|---|
| `assetNeedsInstitution` | Depository/investment types → institution + account number |
| `assetIsGiftOrGrant` | gift_cash / gift_equity / grant → donor source + deposited yet |

### Real estate owned
| Rule | Fires when |
|---|---|
| `reoIsRental` | REO `occupancy = investment` → monthly rental income |

### Declarations
| Rule | Fires when |
|---|---|
| `declaredBankruptcy` | `declaredBankruptcy = true` → bankruptcy chapter |
| `declarationNeedsExplanation` | Any adverse-history declaration answered `yes` → written explanation opens. If all are answered `no` → n/a |

## Section gates

Two sections are gated by an explicit yes/no so that "I have no debts" is a **recorded answer**
rather than an empty section indistinguishable from an unfinished one (§10 `no_vs_not_applicable`):

| Gate field | Controls |
|---|---|
| `parties[].hasAnyLiabilities` | The liabilities section |
| `parties[].ownsOtherRealEstate` | The REO section |

Answering `false` marks any started records in that group `not_applicable` under the named rule
(`hasAnyLiabilities=false`), and the completeness engine stops requiring the group.

## Structural requirements

Not single fields — enforced by `completenessEngine.structuralRequirements`:

| Kind | Meaning |
|---|---|
| `min_records` | A required group has no records yet (residence, employment, income, assets always; liabilities/REO when gated on) |
| `history_backfill` | The 24-month window is not covered — ask for the prior job/address |
| `history_gap` | An unexplained break inside the window |
| `history_overlap` | Overlapping dates — usually two concurrent jobs; the engine asks rather than assumes |

### History coverage

`REQUIRED_EMPLOYMENT_HISTORY_MONTHS = 24`, `REQUIRED_RESIDENCE_HISTORY_MONTHS = 24`.

Two deliberate refinements, both found by tests:

1. **History is not analyzed until the records we already have are complete.** If any existing
   record is missing its start date (or end date, when not current), `collectHistory` returns
   `null`. Asking *"where did you work before that?"* while the current job's start date is
   still blank is exactly the premature question this engine exists to prevent.

2. **Employment history is skipped for classifications with no VOE window** — a retired or
   "other" classification does not trigger backfill.

Ordering within a section reflects the same principle: start a missing first record (0) → fill
the fields of records that exist (1) → only then extend history backwards (2).

## Planner priority

Fixed, and the model has no vote:

1. a contradiction blocking a section
2. a required clarification
3. the currently active logical group (finish what we started)
4. missing high-impact fields
5. missing dependent details
6. captured values still awaiting confirmation
7. final review

## Contradiction policy

Deterministic, and it never picks a winner:

| Situation | Outcome |
|---|---|
| New value differs from a **resolved** value, no correction intent | `conflicting` — both retained |
| New value differs, borrower **is** correcting | `superseded` — old kept in history, new needs confirmation |
| Two different **unconfirmed** answers on a `confirmRequired` field | `conflicting` |
| Differing value on a low-impact unconfirmed field | Newest wins (`superseded`) |

A `conflicting` field cannot be confirmed away — `confirmValue` returns
`resolve_conflict_first`. Only `resolveConflict` with one of the **recorded** values clears it.

## Versioning

Changing a rule's semantics requires bumping `RULES_VERSION`. The version is stored on every
application row so an application can always be re-read against the rules that shaped it.
