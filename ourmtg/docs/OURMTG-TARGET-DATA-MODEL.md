# OURMTG — Target Data Model (reconciled)

**Repo:** `westccmortgage/Ourmtg` · **Branch:** `claude/ourmtg-ai-operations-phase0-rebase` · **Base:** `1a224bf`

This model is **reconciled against the schema that already exists** (migrations 036–039). It does **not** re-propose tables that exist, and it never duplicates a vocabulary the app already defines. Any SQL implied here is captured as **non-runnable drafts** under `ourmtg/docs/phase0/draft-migrations/` — nothing here is applied.

Guiding constraints (from the actual codebase, not the old audit):
- **GRCRM is source of truth**; these tables are a **projection**, service-role write / RLS read.
- **Tenancy = `owner_user_id`** (the broker's GRCRM `auth.users.id`). There is **no `org_id`** today. New tables MUST carry `owner_user_id` and follow the same FK/cascade rules, or explicitly justify otherwise.
- **All new tables:** RLS enabled, SELECT-only policies for the authenticated role, all writes through the service-role gateway with `resolveAccess`/`isInternal`/`canSeeFinancials` in code.
- **No new stage/status enum** that overlaps an existing one. Stages live in `pipeline.js`/`STAGE_META` (`lead,preapproval,processing,underwriting,conditional,ctc,funded`); doc status in `loan_documents` (`requested,uploaded,accepted,rejected`); condition status (`open,submitted,cleared`); strategy status (`draft,approved,hidden`). Reuse these.

---

## Part A — Existing tables (KEEP; do not recreate)

| Table (migration) | Role in target system | Change in Phase 1+ |
|---|---|---|
| `loan_files` (036) | The loan-file projection; tenancy anchor via `owner_user_id`, dedup `(owner_user_id, source_deal_id)` | Untouched by new work except additive columns if justified; **`preapproval_*` remain human-set only** |
| `portal_users` (036/038) | External identity (borrower/coborrower/realtor/escrow/title) | Untouched |
| `portal_access` (036/038) | Grant + visibility (row-level entitlement) | Untouched; new visibility roles only if a new participant type is added |
| `loan_documents` (036) | Document requests + uploads | Reuse `status` vocab; extend `doc_key` catalog only |
| `loan_conditions` (036) | Underwriting conditions | Untouched |
| `loan_messages` (036/038) | Per-file timeline (borrower/coborrower-readable) | Reuse for human messages; **do not** overload as the event stream (see B1) |
| `portal_consent` (036) | Immutable consent ledger (SET NULL FKs) | Reuse for `sms/email/econsent/credit_pull_auth`; source of truth for disclosure consent |
| `portal_access_log` (036) | Immutable audit (view/download/upload/login) | Reuse; do not replace |
| `loan_strategy` (036) | WCCI/AI draft with LO-approval RLS gate | Reuse as the AI-output store; extend `payload` shape, keep `draft→approved→hidden` |
| `portal_invites` (037/038) | Tokenized identity-bound invites | Untouched |
| `portal_team` (038) | Owner↔member internal access | Reuse; a stored task model (B2) would reference members |
| `site_settings` (039) | Public singleton config | **Fix authz (R1)**; no schema change required |

**Relationship / integrity facts to preserve:**
- Every file-scoped child FKs `loan_file_id → loan_files(id) ON DELETE CASCADE`.
- Every owner-scoped row FKs `owner_user_id → auth.users(id) ON DELETE CASCADE`.
- Ledger/audit rows (`portal_consent`, `portal_access_log`) FK **ON DELETE SET NULL** so history survives.
- `updated_at` maintained by the shared `set_updated_at()` trigger where present.

---

## Part B — New objects (proposed; drafts only, default-off)

Each new object below is a **DRAFT**. It is mapped to existing tables, specifies ownership/FK/delete/RLS/index/idempotency, and is gated behind a default-off feature flag. None is created in Phase 0.

### B1. `loan_events` — immutable domain-event stream
**Why:** the target system (automations, AI supervisor, delivery tracking) needs a general append-only event log. `loan_messages` is human timeline; `portal_access_log` is access audit — neither models domain events (`lead.created`, `deal.stage_changed:processing`, `doc.uploaded`, `condition.cleared`, `notification.sent`). Do **not** overload either.

- **Ownership:** `owner_user_id` (tenant), `loan_file_id` (nullable — some events precede a file, e.g. `lead.created`).
- **FKs:** `loan_file_id → loan_files(id) ON DELETE SET NULL` (preserve history), `owner_user_id → auth.users(id) ON DELETE CASCADE`.
- **Columns (concept):** `id uuid pk`, `owner_user_id`, `loan_file_id null`, `event_type text` (dotted vocab), `actor_role text`, `actor_user_id uuid null`, `payload jsonb`, `idempotency_key text`, `created_at timestamptz default now()`.
- **Idempotency:** `unique (owner_user_id, idempotency_key)` — projector/automation writes are safe to retry; matches the "armed, idempotent" automation-engine guarantee.
- **Immutability:** SELECT-only RLS; **no UPDATE/DELETE policy**; consider a REVOKE-based hard guard in the draft (documented, not applied).
- **RLS read:** internal (owner/team) only by default; borrower-safe events (if ever exposed) go through the gateway with column scoping, not direct RLS.
- **Indexes:** `(loan_file_id, created_at desc)`, `(owner_user_id, event_type, created_at desc)`.

### B2. `loan_tasks` — first-class internal/borrower tasks (owner decision #3)
**Why:** today "next action" is *computed* in `portal-review-queue`; team tasks are not assignable or persisted. Only build if the owner wants stored, assignable tasks.
- **Ownership:** `owner_user_id`, `loan_file_id`.
- **FKs:** both `ON DELETE CASCADE` (a task without its file/owner is meaningless).
- **Columns:** `id`, `owner_user_id`, `loan_file_id`, `assignee_user_id uuid null` (→ `portal_team.member_user_id` or owner), `audience text check (audience in ('team','borrower'))`, `title`, `detail`, `status text check (status in ('open','done','cancelled'))`, `due_at`, timestamps.
- **Do NOT** reuse `loan_conditions` (that is underwriting-specific with its own `open/submitted/cleared` lifecycle) — a task is a different concept; keeping them separate avoids two conflicting status models.
- **RLS:** internal by default; borrower-audience tasks readable by borrower/coborrower grant.
- **Indexes:** `(owner_user_id, status, due_at)`, `(loan_file_id)`.

### B3. `notification_deliveries` — delivery tracking (R5)
**Why:** `mailer.mjs` is fail-soft with no persisted record. Target needs "was it sent/delivered/failed."
- **Ownership:** `owner_user_id`, `loan_file_id null`.
- **FKs:** `loan_file_id → loan_files ON DELETE SET NULL`, `owner_user_id ON DELETE CASCADE`.
- **Columns:** `id`, `owner_user_id`, `loan_file_id null`, `channel text check (channel in ('email','sms'))`, `template_key text`, `recipient text`, `status text check (status in ('queued','sent','failed','skipped'))`, `provider_id text null`, `error text null`, `idempotency_key text`, `created_at`.
- **Idempotency:** `unique (owner_user_id, idempotency_key)` so a retried send is not double-recorded (and, paired with the guarded send, not double-delivered).
- **RLS:** internal-only read.
- **Indexes:** `(loan_file_id, created_at desc)`, `(owner_user_id, status)`.

### B4. `loan_vendor_orders` — appraisal / title / escrow / insurance status
**Why:** target lists appraisal/title/escrow/insurance. Today escrow/title are only **access roles** (milestone-only), not tracked vendor orders.
- **Ownership:** `owner_user_id`, `loan_file_id`.
- **FKs:** both `ON DELETE CASCADE`.
- **Columns:** `id`, `owner_user_id`, `loan_file_id`, `vendor_type text check (vendor_type in ('appraisal','title','escrow','insurance'))`, `vendor_name`, `status text check (status in ('ordered','in_progress','received','cleared','cancelled'))`, `ordered_at`, `received_at`, `detail jsonb`, timestamps.
- **Milestone exposure:** realtor/borrower visibility is milestone-only via the gateway (never direct financial detail), consistent with `portal-status`.
- **Indexes:** `(loan_file_id, vendor_type)`.

### B5. `loan_cash_to_close` — actual CTC ledger
**Why:** CTC exists only as a client-side estimate. A transactional ledger is a distinct object.
- **Ownership:** `owner_user_id`, `loan_file_id`.
- **FKs:** both `ON DELETE CASCADE`.
- **Columns:** `id`, `owner_user_id`, `loan_file_id`, `line_key text`, `label text`, `amount numeric`, `direction text check (direction in ('credit','charge'))`, `source text` (LE/CD/manual), `as_of date`, timestamps.
- **Borrower exposure:** through the gateway, borrower/coborrower only, never realtor.
- **Indexes:** `(loan_file_id)`.

### B6. `loan_disclosures` / e-sign tracking (owner decision #4 — vendor vs in-house)
**Why:** LE/CD delivery, ESIGN acknowledgment, and signatures are absent. Shape depends on the signing decision, so this stays a **sketch**, not a firm draft.
- If **vendor** (DocuSign/Dropbox Sign): store envelope references + status, not documents; consent already captured in `portal_consent`.
- If **in-house**: extend `loan_documents` semantics or add `loan_disclosures(id, owner_user_id, loan_file_id, disclosure_type, status in ('sent','viewed','acknowledged','signed'), signed_at, storage_path)`.
- **Do not** conflate with `loan_documents` (borrower *uploads* vs lender-*delivered* disclosures are different directions/lifecycles).

### B7. AI File Supervisor — reuse `loan_strategy`, add a decisions log
**Why:** the WCCI/AI output store already exists (`loan_strategy`, with the `draft→approved` RLS gate — the correct governance primitive). What's missing is a **supervisor action/decision log** (what the AI flagged, what a human did).
- Reuse `loan_strategy` for AI-generated *content* (extend `payload`/`summary`; keep the approval gate).
- Add supervisor findings as `loan_events` (B1) rows (`event_type='ai.flag'`, `'ai.next_best_action'`) rather than a new table, unless a first-class reviewable queue is needed.
- **Governance (non-negotiable, from spec §C/§M):** AI output is server-side only, never quotes rates / promises approval / asserts DPA eligibility, and is invisible to borrowers until LO-approved. Any borrower-facing AI text passes the `loan_strategy` approval gate.

---

## Part C — Migration compatibility & rollback

- **Numbering:** new migrations continue at **040+** (039 is the last real one). Drafts in `ourmtg/docs/phase0/draft-migrations/` are named `040_*.DRAFT.sql` etc. and are **outside** `supabase/migrations/` so the manual SQL-editor process cannot pick them up.
- **Idempotency:** every draft uses `create table if not exists`, `create index if not exists`, `drop policy if exists` before create, and `on conflict do nothing/update` for seeds — matching the existing 036–039 style.
- **Additive-only:** no draft drops or rewrites an existing column/constraint except where explicitly reconciling a documented defect. Constraint changes (as in 038) must drop the auto-named `<table>_<column>_check` and recreate.
- **Rollback:** each draft ships a commented `-- ROLLBACK` section (drop new tables/policies/indexes in reverse dependency order). Because new tables are additive and default-off at the app layer, rollback is "drop the new tables"; existing behavior is unaffected.
- **RLS default-deny:** every new table `enable row level security` with SELECT-only policies; absence of a policy means default-deny (as `loan_files` already demonstrates).
- **Verification queries:** each draft includes a `-- VERIFY` block mirroring the runbook's table-count / bucket checks.

---

## Part D — What NOT to do (reconciliation guardrails)

- ❌ Do not create a second stage enum, task-status enum, or doc-status enum. Reuse existing vocabularies.
- ❌ Do not add a parallel timeline table; `loan_messages` is the human timeline, `loan_events` (if built) is the machine stream — one each.
- ❌ Do not write borrower data back into GRCRM `app_state`.
- ❌ Do not make `preapproval_*` projector-written; it stays human-set (`portal-preapproval-set`).
- ❌ Do not weaken realtor/escrow/title structural blocks (RLS **and** code).
- ❌ Do not store financial docs anywhere but the private `ourmtg-docs` bucket.
- ❌ Do not uncomment draft SQL into the numbered migration sequence during Phase 0.

---

## Part E — Future tenancy: explicit `organization_id` (owner directive, Phase 1A)

**Decision (owner):** `owner_user_id`-only tenancy is **not approved as the final model**. Today's
schema (036–039) scopes everything by `owner_user_id` (the broker's `auth.users.id`) with no
`org_id`. That is acceptable for the current single-owner deployment but must not harden into the
permanent boundary.

**Requirement:** the **first real operational migrations** (Phase 2+, when draft 040/041 become
actual `supabase/migrations/*.sql`) must introduce an explicit `organization_id` boundary:

- Add an `organizations` table (`id uuid pk`, name, created_at) and an `organization_id` column on
  every new operational/domain table (`loan_events`, `notification_deliveries`, `loan_tasks`,
  `loan_vendor_orders`, `loan_cash_to_close`) **in addition to** `owner_user_id`.
- Index `organization_id`; scope RLS and application authorization by it (an owner/team belongs to
  an organization; cross-org reads are denied).
- Provide a backfill that maps existing `owner_user_id`s to a default organization so the migration
  is non-breaking, and a membership table (`organization_members(organization_id, user_id, role)`)
  that generalizes today's `portal_team` owner↔member relationship.
- Existing tables (036–039) can adopt `organization_id` later via additive columns; do **not**
  rewrite them in Phase 1A (no schema changes this phase).

**Phase 1A stance:** this is recorded as the target only. **No tenancy schema change is made in
Phase 1A** (owner decision #7: no new production tables; #9: no migrations applied). The directive
binds the Phase 2 migration authors, not this phase.
