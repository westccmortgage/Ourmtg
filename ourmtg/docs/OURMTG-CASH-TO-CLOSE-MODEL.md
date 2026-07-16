# OURMTG — Cash-to-Close Planning Model (§10)

Canonical source: `src/domain/cashToClose.js` (`computeCashToClose`). Pure, deterministic, no clock.
Tested in `tests/cashToClose.test.mjs` (the 10 required cases). UI: `src/components/CashToClosePanel.jsx`
(flag-gated `flags.cashToClosePlanner`). **Planning estimate only — never a lender quote or final escrow figure.**

## Inputs (all optional; a value may be a number, `{low, high}`, or `{amount}`)
`purchasePrice, downPaymentAmount, downPaymentPercent, loanAmount, earnestMoney, lenderOrigination,
points, appraisalThirdParty, titleEscrow, recordingGovernment, prepaidInterest, homeownersInsurance,
taxAndInsuranceReserves (escrow impounds), reservesAfterClosing (post-closing liquidity),
sellerCredits, lenderCredits, otherCredits, cashIdentified, sourceType, verified, classification, asOf`.

## Outputs
`downPayment, grossClosingCosts, prepaidItems, depositsAndCredits, estimatedCashToClose,
range {low, high}, creditSurplus, reservesRequirement, cashIdentified, estimatedShortfall,
estimatedSurplus, classification, lines[] (per-line label/amount/low/high/explanation), assumptions[], calculatedAt`.

## Calculation
```
downPayment          = amount | price×pct | price−loan       (never merged with closing costs)
grossClosingCosts    = origination + points + appraisal/third-party + title/escrow + recording
prepaidItems         = prepaid interest + homeowners insurance + escrow impounds
depositsAndCredits   = earnest money + seller + lender + other credits
estimatedCashToClose = max(0, downPayment + grossClosingCosts + prepaidItems − depositsAndCredits)
creditSurplus        = credits beyond costs (when the raw figure would be negative)
reservesRequirement  = reservesAfterClosing            (SEPARATE — never in cash to close)
net                  = cashIdentified − estimatedCashToClose  → shortfall (net<0) or surplus (net>0)
```

## Rules (enforced + tested)
- Down payment is **never** merged with closing costs (separate line + output).
- Discount **points** are always a separate line from origination.
- **Post-closing reserves** are a separate requirement, never a closing fee, never inside cash-to-close.
- Escrow **impounds** (tax/insurance reserves) ARE part of cash-to-close (a prepaid), distinct from post-closing reserves.
- Earnest money and credits **reduce** cash needed.
- Negative line items handled explicitly; cash-to-close **never goes below zero** — a negative result is a **surplus**.
- Ranges supported (low/high propagate to the total).
- No fabricated verified values.

## Classification (confidence, low→high)
`illustrative` (≤2 inputs) · `estimated` (default) · `verified` (caller asserts `verified:true`) ·
`final` (**only** with a verified final source — `sourceType:'closing_disclosure'` + `verified:true`).
Requesting `final` without that source is **downgraded to estimated** — never faked.
