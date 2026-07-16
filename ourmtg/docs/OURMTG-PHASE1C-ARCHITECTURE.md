# OURMTG — Phase 1C Architecture (Operational Pilot Wiring)

Branch `claude/ourmtg-phase1c-operational-pilot` · base `ef8bb68`. Stack unchanged (Vite/React/
Netlify/Supabase). The first production-shaped vertical slice: **team creates a borrower document
task → borrower acts → team reviews → every material transition writes an immutable event +
task-history atomically.** Migration is **written but NOT applied**; UI is flag-gated (default off).

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
docs/phase1c/migration/043_ourmtg_operational_pilot.sql   real DDL + 2 atomic RPCs (NOT applied)
netlify/functions/
  _lib/orgAccess.mjs        resolve caller org membership + actor-type mapping
  _lib/taskRepo.mjs         validate via pure taskService → persist via ONE atomic RPC; borrower scrub
  _lib/notificationIntent.mjs  intent-only mapping (no send)
  portal-task-list.mjs · portal-task-detail.mjs · portal-task-create.mjs · portal-task-transition.mjs
  portal-doc-complete.mjs   (+ optional taskId → submit on finalize)
src/lib/  api.js (task wrappers, uploadDocument taskId) · taskLabels.js (EN/ES/RU)
src/components/  NeedsAttention.jsx (real tasks + fallback) · TeamTaskCard.jsx
src/pages/  BorrowerDashboard.jsx · LoanFileDetail.jsx · Documents.jsx (?task deep link)
```

## Atomicity
Validation is delegated to the canonical Phase 1B pure `taskService` (role/AI/graph/review rules);
persistence is a **single `SECURITY DEFINER` RPC** (`ourmtg_task_transition` / `ourmtg_task_create`)
that updates the task, appends `loan_task_history`, and appends `loan_events` in **one transaction**.
On any failure the RPC RAISES and all three roll back — there is no independent client-side
insert of history/event. Proven by `tests/taskRepo.test.mjs` (invalid → zero writes; rpc-throw →
zero partial writes; duplicate key → one side effect).

## Organization boundary
`organizations` + `organization_members` are explicit. The gateway resolves the caller's active
membership (`resolveOrg`) and rejects a request whose task/file org ≠ the caller's org
(`Cross-organization access denied`); the RPC re-checks (`org_mismatch`). Membership is never
inferred from an email domain; there is no public org signup. Single-org pilot: a caller's org is
their first active membership; the backfill maps existing loan-file owners to the WCC organization.

## Security posture (unchanged from 1A/1B + new)
Admin allowlist, cron Bearer secret, public rate limiting, MIME/extension policy, signed URLs,
`no-store`, security headers, safe logging, JWT validation, service-role isolation — all preserved.
New: task endpoints are authenticated + org-scoped + loan-file-authorized; borrower reads are
field-scoped (internal_requirement never leaves the server); AI remains a proposer only.

## Wiring status
- **Implemented + wired to endpoints:** task repositories, 4 endpoints, doc-task linking, notification-intent.
- **Flag-gated (default OFF):** `VITE_FF_TASK_PILOT` (borrower real tasks), `VITE_FF_LOAN_TEAM_TASK_PILOT` (team card). Flag off ⇒ current behavior unchanged.
- **Migration-ready but UNAPPLIED:** `043_ourmtg_operational_pilot.sql` (apply to a Supabase branch only — see acceptance doc).
- **Adapter-tested, not database-tested:** repositories/atomicity/idempotency verified via injected fakes; live DB test is the branch acceptance script.
- **Deferred / not integrated:** cash-to-close persistence, disclosures, third-party, milestones, notification SENDING, Arive, e-sign, AI actions.
