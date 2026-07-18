# OURMTG — Phase 1B Current Feature Map (§2)

Branch `claude/ourmtg-phase1b-borrower-operations` · base `fd0373f`. Reconciliation of existing
implementation vs Phase 1B targets. Legend: **reuse** (existing & reusable) · **extend** ·
**replace** · **leave** (untouched) · **missing** (new, this phase draft/flag-gated).

| Existing artifact | State | Notes |
|---|---|---|
| `loan_files` (036) | leave | file projection; tenancy anchor; Phase 1B org boundary is draft-only |
| `portal_access` (036/038) | leave | grant + visibility; still authoritative |
| `portal_invites` (037/038) | leave | invitation flow preserved |
| `loan_documents` (036) | reuse | drives borrower "needs attention" (needsAttention.js) |
| `loan_conditions` (036) | reuse | drives needs-attention + future `loan_tasks.source_condition_id` |
| `loan_strategy` (036) | leave | AI/WCCI draft store; borrower sees approved-only (unchanged) |
| `app_state` (GRCRM) | leave | read-only projector source; never written |
| portal consent (`portal_consent`) | leave | TCPA ledger unchanged |
| pre-approval (`portal-preapproval-set`) | leave | human-set realtor band unchanged |
| document checklist (`portal-checklist`) | reuse | feeds needs-attention + documents section |
| document review (`portal-doc-review`) | leave | race-safe accept/reject unchanged |
| loan stages (`pipeline.js` 7-stage) | reuse | NOT redefined; milestones are a distinct concept mapped to it |
| `LoanFileDetail` | leave | LO drill-in unchanged |
| `BorrowerDashboard` | extend | additive flag-gated sections (needs-attention, cash-to-close, third-party) + verified team card |
| `LODashboard` | extend | additive flag-gated blockers + "what changed today" |
| `RealtorPortal` | leave | milestone-only; visibility rules reaffirmed in tests |
| `Documents` | leave | upload flow unchanged (upload-policy from 1A already applies) |
| notification email paths (`_lib/mailer`) | leave | fail-soft sends unchanged; new notification MODEL is separate + flag-gated |

| Phase 1B target capability | State | Where |
|---|---|---|
| First-class tasks + lifecycle | missing (draft+flag) | `services/taskService.js`, draft `loan_tasks`/`loan_task_history` |
| Append-only event ledger | missing (draft+flag) | `services/eventService.js`, draft `loan_events` |
| Milestones | missing (draft) | draft `loan_milestones` (mapped to the 7 stages, not a second stage enum) |
| Cash-to-close planning engine | missing (implemented, pure) | `cashToClose.js` (+ UI panel flag-gated) |
| Cash-to-close ledger/snapshots | missing (draft) | draft `cash_to_close_items`/`_snapshots` |
| Disclosure tracking (no e-sign) | missing (implemented, pure) | `services/disclosureService.js` (+ draft `disclosure_packages`) |
| Third-party items | missing (draft + placeholder UI) | draft `third_party_items` (+ `ThirdPartyPanel`) |
| Notification event model | missing (implemented, pure) | `services/notifications.js` |
| Organization tenancy | missing (draft) | draft `organizations`/`organization_members` |
| AI boundary enforcement | missing (contracts + tests) | `services/aiBoundary.js` (no active AI) |

**Non-duplication:** the 7-stage pipeline vocabulary is re-used (not forked); the Phase 0
placeholder `TASK_STATUS` (open/done/cancelled) is **superseded** by the single canonical 13-state
lifecycle in `lifecycles.js` (re-exported by `vocab.js`) — one task model, not two.
