# OURMTG — Task Transition Matrix (§6)

Canonical source: `src/domain/lifecycles.js` (`TASK_TRANSITIONS`) + `src/domain/services/taskService.js`.
Tested in `tests/taskService.test.mjs`. Flag-gated (`flags.taskServiceEnabled`, default OFF); not wired to production.

## States (13)
`created → assigned → viewed → in_progress → submitted → prechecked → team_review → accepted → rejected → more_information_needed → completed → reopened → cancelled`
Terminal: `completed` (may reopen), `cancelled`.

## Transition graph (from → allowed to)
| From | Allowed next |
|---|---|
| created | assigned, cancelled |
| assigned | viewed, in_progress, cancelled |
| viewed | in_progress, cancelled |
| in_progress | submitted, cancelled |
| submitted | prechecked, team_review, more_information_needed, rejected, cancelled |
| prechecked | team_review, more_information_needed, rejected, cancelled |
| team_review | accepted, rejected, more_information_needed |
| rejected | in_progress, reopened, cancelled |
| more_information_needed | in_progress, submitted, cancelled |
| accepted | completed, reopened |
| completed | reopened |
| reopened | assigned, in_progress, cancelled |
| cancelled | — (terminal) |

## Actor permissions
| Actor | May transition to |
|---|---|
| loan_officer / processor / assistant (team) | any valid transition |
| borrower / coborrower | viewed, in_progress, submitted **only** (never accept/complete/cancel/review) |
| system | assigned, cancelled only |
| realtor / escrow / title | **none** — no access to financial tasks (`forbidden_role`) |
| ai | **none** — `ai_forbidden` (AI may only PROPOSE, never act) |

## Hard rules (enforced + tested)
1. Invalid graph transitions are rejected (`invalid_transition`).
2. Document/condition/signature tasks (`REVIEW_REQUIRED_TASK_TYPES`) reach `accepted` **only** from `team_review` (`review_required`). A borrower cannot accept their own submitted document.
3. AI cannot accept, complete, clear, or cancel a material task (`ai_forbidden`).
4. Realtor/escrow/title cannot access financial tasks at all.
5. Every transition writes an immutable `loan_task_history` row (from, to, actor, reason, evidence).
6. Reopened tasks **retain** prior evidence + history (evidence is appended, never wiped).
7. `created` may only be produced by team/system (AI/partner creation rejected).
