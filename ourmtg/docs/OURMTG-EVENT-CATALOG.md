# OURMTG — Event Catalog (§5)

Canonical source: `src/domain/lifecycles.js` (`EVENT_TYPES`) + append-only `src/domain/services/eventService.js`.
Tested in `tests/eventService.test.mjs`. Flag-gated (`flags.eventServiceEnabled`, default OFF); not wired to production endpoints.

## Event record (draft `loan_events`)
`id, organization_id (required), loan_file_id (required at service), event_type, actor_type, actor_id, source_system (required), source_record_id, correlation_id, idempotency_key, previous_state, new_state, metadata, occurred_at, created_at`.

Rules: append-only (never mutated), idempotent (`unique(organization_id, idempotency_key)` → a repeat key returns the existing event, no second side effect), actor + source attribution required, metadata carries no secrets/PII, the service never logs metadata.

## Catalog
| event_type | Emitted when | Notable payload |
|---|---|---|
| `lead.created` | a public lead is submitted | source flow/tag |
| `deal.stage_changed` | pipeline stage advances | `{ from, to }` (to ∈ 7 stages) |
| `doc.requested` / `doc.uploaded` / `doc.accepted` / `doc.rejected` | document lifecycle | doc_key, reason on reject |
| `condition.opened` / `condition.submitted` / `condition.cleared` | UW condition lifecycle | condition id |
| `preapproval.set` / `preapproval.cleared` | LO sets/clears realtor band | amount band, expiry |
| `invite.created` / `invite.accepted` | portal invite lifecycle | role |
| `message.sent` | portal message | direction, author_role |
| `task.created … task.cancelled` (13) | each task transition | from/to status, actor |
| `milestone.reached` | milestone completed | milestone_type |
| `disclosure.status_changed` | disclosure package transition | from/to status |
| `cashtoclose.updated` | CTC items/snapshot changes | classification |
| `thirdparty.status_changed` | appraisal/title/escrow/insurance status | item_type, status |
| `notification.queued` / `notification.sent` | notification lifecycle | template_key, channel |
| `ai.flag` / `ai.next_best_action` | AI PROPOSAL recorded (never an action) | requires_human_approval |

Validation: `event_type` must be in `EVENT_TYPES`; `actor_type` in the actor set; unknown → rejected. The catalog is additive — new events append to `EVENT_TYPES` (never renumber/rename existing).
