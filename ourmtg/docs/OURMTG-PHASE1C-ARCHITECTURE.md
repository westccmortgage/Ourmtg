# OURMTG — Phase 1C Architecture (Operational Pilot Wiring)

Branch `claude/ourmtg-phase1c-operational-pilot` · base `ef8bb68`. Stack unchanged (Vite/React/
Netlify/Supabase). The first production-shaped vertical slice: **team creates a borrower document
task → borrower acts → team reviews → every material transition writes an immutable event +
task-history atomically.** Migration is **written but NOT applied**; both UI and **backend** are
flag-gated (default off). Rev 2 folds in external-review findings EXT-1..EXT-13 (see
`OURMTG-PHASE1C-EXT-RECONCILIATION.md`).

## Vertical slice
```
[Team] portal-task-create ──► ourmtg_task_create (RPC: task + history + event, 1 txn)
[Borrower] portal-task-list/detail ──► field-scoped reads (no internal_requirement)
[Borrower] upload via existing signed-URL flow ──► portal-doc-complete(taskId)
          └─ AFTER finalize success ──► ourmtg_task_transition(submit, linked_document_id)
[Team] portal-task-transition (accept/reject/more_info/reopen) ──► ourmtg_task_transition
Every material op ──► one loan_events row (idempotent) + one loan_task_history row + task update, ATOMIC
```

## Layers added
```
docs/phase1c/migration/043_ourmtg_operational_pilot.sql   real DDL + 3 atomic RPCs + 3 helper fns (NOT applied)
netlify/functions/
  _lib/orgAccess.mjs        LOAN-SCOPED org resolution (EXT-1): internal=member, borrower=portal_access
  _lib/featureFlags.mjs     EXT-10 fail-closed server flags (FF_TASK_PILOT / FF_LOAN_TEAM_TASK_PILOT)
  _lib/idempotency.mjs      EXT-8 mandatory key + canonical request-hash
  _lib/requestGuard.mjs     EXT-11 JSON/size/UUID/enum/timestamp + prototype-pollution rejection
  _lib/taskRepo.mjs         validate via pure taskService → persist via ONE atomic RPC; borrower scrub + participant scope
  _lib/notificationIntent.mjs  intent-only mapping (no send)
  portal-task-list.mjs · portal-task-detail.mjs · portal-task-create.mjs · portal-task-transition.mjs
  portal-doc-complete.mjs   (+ optional taskId → ourmtg_document_finalize_submit, EXT-5 atomic)
src/lib/  api.js (task wrappers, uploadDocument taskId) · taskLabels.js (EN/ES/RU + reasonLabel EXT-6)
src/components/  NeedsAttention.jsx (real tasks + reason + fallback) · TeamTaskCard.jsx (participant/reason UI)
src/pages/  BorrowerDashboard.jsx · LoanFileDetail.jsx · Documents.jsx (?task deep link)
```

## Atomicity + concurrency (EXT-4/5/8/9)
Validation is delegated to the canonical Phase 1B pure `taskService` (role/AI/graph/review rules) for
fast-fail; the **DB RPC is authoritative**. `ourmtg_task_transition` takes an **action + expected
revision** (never a status): it locks the row `FOR UPDATE`, rejects a `revision` mismatch with
`stale_task`, re-validates the graph, **derives** the to-status and event type server-side, bumps
`revision`, and appends `loan_task_history` + `loan_events` in **one transaction** — plus, on
reject/more-info, a same-transaction notification intent (EXT-9). `ourmtg_document_finalize_submit`
(EXT-5) does mark-uploaded + link + submit + history + event atomically. Idempotency is a mandatory key
+ `request_hash`: same key + same payload dedupes, same key + different payload raises
`idempotency_conflict` (EXT-8). On any failure the RPC RAISES and everything rolls back. Proven by
`tests/taskRepo.test.mjs` (invalid → zero writes; rpc-throw → zero partial writes; stale loser → zero
writes; duplicate key → one side effect; conflict on different payload; cross-loan finalize → nothing
changes).

## Organization boundary (EXT-1)
The org is resolved from the **loan file** (`loan_files.organization_id`), not from an arbitrary first
membership. Internal (owner/team) callers must be **active members** of that org; borrowers/co-borrowers
ride `portal_access` with **no** membership; users may belong to many orgs (resolution is always against
the file's org); realtor/escrow/title are denied. The gateway rejects task/file org ≠ context
(`Cross-organization access denied`) and the RPC re-checks (`org_mismatch`). Membership is never inferred
from an email domain. The EXT-13 backfill is deterministic on `organizations.slug`
(`west-coast-capital-mortgage`). Proven by `tests/orgAccess.test.mjs`.

## Security posture (unchanged from 1A/1B + new)
Admin allowlist, cron Bearer secret, public rate limiting, MIME/extension policy, signed URLs,
`no-store`, security headers, safe logging, JWT validation, service-role isolation — all preserved.
New: task endpoints are **fail-closed flag-gated** (EXT-10), authenticated, loan-scoped-org-authorized
(EXT-1), and request-hardened (EXT-11: JSON/size/UUID/enum + prototype-pollution rejection). Base tables
carry no borrower SELECT (EXT-2); RPCs are `service_role`-only with pinned `search_path` (EXT-3). Borrower
reads are field- and participant-scoped (`internal_requirement` never leaves the server; only
`borrower_visible_status_reason` is exposed). Audit tables are immutable and protected from cascade
erasure with `ON DELETE RESTRICT` (EXT-12). AI remains a proposer only.

## Wiring status
- **Implemented + wired to endpoints:** task repositories, 4 endpoints, atomic doc-task finalize,
  in-transaction notification-intent, loan-scoped org resolution, server flags, request hardening.
- **Flag-gated (default OFF), fail-closed on the server:** `FF_TASK_PILOT` / `FF_LOAN_TEAM_TASK_PILOT`
  authorize the backend (EXT-10); `VITE_FF_*` is presentation-only. Flag off ⇒ endpoints `404`, current
  behavior unchanged.
- **Migration-ready but UNAPPLIED:** `043_ourmtg_operational_pilot.sql` Rev 2 (apply to a Supabase branch
  only — see acceptance doc).
- **Adapter-tested, NOT database-tested:** repositories/atomicity/idempotency/concurrency verified via
  injected fakes (`npm test`, 179 tests). Fake-adapter tests are **not** live-database tests; the live DB
  test is the branch acceptance script, which has **not** been run.
- **Deferred / not integrated:** cash-to-close persistence, disclosures, third-party, milestones,
  notification SENDING, Arive, e-sign, AI actions.
