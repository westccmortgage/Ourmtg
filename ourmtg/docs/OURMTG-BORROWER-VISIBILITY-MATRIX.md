# OURMTG — Borrower / Role Visibility Matrix (§13)

Canonical source: `src/domain/visibility.js` + server authz `_lib/portal.mjs` (`resolveAccess`,
`canSeeFinancials`, `isInternal`). Tested in `tests/roleVisibility.test.mjs`, `tests/access.test.mjs`.
**Frontend gating is not security** — every server endpoint re-derives authority from the JWT + grants.

| Data / capability | Borrower (own file) | Co-borrower (own file) | Realtor | Escrow / Title | Loan team | Platform admin |
|---|---|---|---|---|---|---|
| Own loan status / stage | ✅ | ✅ | milestone only | permitted milestones only | ✅ | ✅ |
| Another borrower's file | ❌ (no grant → denied) | ❌ | ❌ | ❌ | ✅ (assigned/team) | n/a |
| Borrower financial documents | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Internal notes / requirements | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Income / asset calculations | ❌ (only their own inputs) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Borrower tasks | own (with grant) | own (with grant) | ❌ | ❌ | ✅ | ✅ |
| Accept own submitted document | ❌ (team-review only) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cash-to-close detail | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Cash account details | own | own | ❌ | ❌ | ✅ | ✅ |
| Pre-approval band | ✅ | ✅ | ✅ (published) | ❌ | ✅ | ✅ |
| Transaction milestones | ✅ | ✅ | major only | permitted only | ✅ | ✅ |
| Write global site settings | ❌ | ❌ | ❌ | ❌ | ❌ (unless allowlisted) | ✅ (allowlist only) |

Key guarantees (tested):
- A borrower with no grant to a file resolves to `null` access — a guessed loan-file id does not bypass authorization.
- Realtor/escrow/title are structurally blocked from documents, financial detail, cash-to-close, and tasks — in RLS **and** code.
- Admin authority (site settings) is the `OURMTG_ADMIN_EMAILS` allowlist only; owning a loan never grants it.
- AI is an actor that may only propose; it cannot perform any material action for any role.
