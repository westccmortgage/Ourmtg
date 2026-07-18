# OURMTG — Phase 1C Independent-Review Fixes

Corrections applied to Phase 1C (`666eb32`). Each finding below was identified by an independent
review of the pilot vertical slice and is resolved on branch `claude/ourmtg-phase1c-operational-pilot`.
No migrations applied; no live DB tests run; flags remain default-off.

| # | Finding | Fix | Files | Evidence |
|---|---|---|---|---|
| **F1** | **Task create was not idempotent** — the endpoint generated a random idempotency key per call, so a retried/double-submit created duplicate tasks. | Honor a client-supplied `idempotencyKey`; `TeamTaskCard` sends a stable per-submit UUID. A duplicate returns the same task. | `portal-task-create.mjs`, `components/TeamTaskCard.jsx`, `api.js` | `tests/taskRepo.test.mjs` "F1/F2" |
| **F2** | **Create RPC dedupe returned no `task_id`** — a deduped create responded with `taskId: undefined`. | RPC now returns the existing `task_id` on dedupe (via the recorded event's `source_record_id`). | `043_ourmtg_operational_pilot.sql` (`ourmtg_task_create`) | same test asserts `b.task_id === a.task_id` |
| **F3** | **Multi-org mis-scoping** — `resolveOrg` picked the caller's *first* active membership; a user in multiple orgs could be mis-scoped or wrongly denied on another org's task. | New `memberOfOrg(svc, user, orgId)` verifies membership in the **record's** org; detail/transition/doc-complete use it. | `_lib/orgAccess.mjs`, `portal-task-detail/transition.mjs`, `portal-doc-complete.mjs` | scoped query by `organization_id` |
| **F4** | **False idempotency dedupe** — key `(task, action, pre-state)` would wrongly dedupe a *legitimate* repeat of the same (action, status) after a reopen cycle. | Include `updated_at` (row version) in the derived key; only a true same-version double-submit collides. | `portal-task-transition.mjs` | key `${taskId}:${action}:${status}:${updated_at}` |
| **F5** | **Borrower-supplied `evidence` stored unbounded** in the immutable history (injection/bloat). | Accept `evidence` only from internal (team) actors and only under a 4 KB serialized cap; borrower evidence ignored (never truncated into invalid JSON). | `portal-task-transition.mjs` | cap-or-drop guard |
| **F6** | **IDOR via `linkedDocumentId`** — the public transition body accepted an arbitrary document id to link to a task. | `linkedDocumentId` is **server-set only** (via `portal-doc-complete`); never read from the transition body. | `portal-task-transition.mjs` | `linkedDocumentId: null` |
| **F7** | **Functions imported across the `src/` boundary** — `taskRepo` imported the pure state machine from `src/domain/…`, fragile for Netlify bundling and against the self-contained-functions rule. | Added functions-local `_lib/taskLifecycle.mjs` (single server source); a parity test asserts it never drifts from `src/domain`. | `_lib/taskLifecycle.mjs`, `_lib/taskRepo.mjs` | `tests/taskLifecycleParity.test.mjs`; no `../../../src` import remains |
| **F8** | **RPC trusted the app layer fully** — no DB-side guard against a no-op/same-status transition. | Transition RPC raises `noop_transition` when `from = to` (defense-in-depth; the enum CHECK already bounds status). | `043_…sql` (`ourmtg_task_transition`) | fake RPC mirrors the guard |
| **F9** | **Unvalidated `dueAt`** — a malformed date reached the DB as an opaque `persist_failed`. | Validate/normalize `dueAt` to ISO in the endpoint; `400 Invalid due date` on bad input. | `portal-task-create.mjs` | date guard |
| **F10** | **Ambiguous "no org" error** — a missing pilot table and a genuine non-member both returned a flat 403. | `resolveOrg`/`memberOfOrg` distinguish **not provisioned** (`503`) from **forbidden** (`403`). | `_lib/orgAccess.mjs`, all task endpoints | `provisioned` flag |
| **F11** | **Duplicate notification-intent on deduped create** — a retried create would emit a second `notification.queued` intent. | Emit the borrower notification-intent only on a **fresh** create (`!deduped`). | `portal-task-create.mjs` | `result.deduped ? null` |
| **F12** | **Latent crash in the evidence guard** — `isInternal` was used in `portal-task-transition` but not imported (runtime `ReferenceError` on any transition). | Import `isInternal` from `_lib/portal.mjs`. | `portal-task-transition.mjs` | `npm run check` + build green |
| **F13** | **Missing regression coverage** for the above. | Added tests: create idempotency + dedupe `task_id`, lifecycle parity (server vs src), no-op guard + dedupe surfaced via the fake RPC. | `tests/taskRepo.test.mjs`, `tests/taskLifecycleParity.test.mjs` | 134/134 pass |

## Verification
- `npm run check` → **ok**  ·  `npm test` → **134 / 134 pass**  ·  `npm run build` → **success**.
- No function imports across the `src/` boundary (functions are self-contained).
- Migrations: **none applied**. Live DB tests: **not run** (branch acceptance script unchanged).
- Docs updated: `OURMTG-TASK-API.md` (transition body no longer takes `linkedDocumentId`; evidence
  internal-only; create idempotency). Flags remain default-off. Phase 1D not started.
