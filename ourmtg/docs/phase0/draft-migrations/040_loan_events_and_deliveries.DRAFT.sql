-- ============================================================================
-- DRAFT — DO NOT APPLY.  Phase 0 planning artifact (Phase 2 target).
-- Objects: loan_events (immutable domain-event stream), notification_deliveries.
-- Reconciled against migrations 036–039. See docs/OURMTG-TARGET-DATA-MODEL.md B1/B3.
-- This file lives OUTSIDE supabase/migrations/ and is guarded non-runnable below.
-- ============================================================================
DO $$ BEGIN
  RAISE EXCEPTION 'DRAFT migration — not for execution. Author a real supabase/migrations/040_*.sql after Phase 1.';
END $$;

-- ---------------------------------------------------------------------------
-- loan_events — append-only domain-event stream (idempotent, immutable).
-- Tenancy = owner_user_id (no org_id, matching existing schema). loan_file_id
-- nullable for pre-file events (lead.created). SET NULL on file delete to keep history.
-- ---------------------------------------------------------------------------
create table if not exists public.loan_events (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  loan_file_id    uuid references public.loan_files(id) on delete set null,
  event_type      text not null,           -- vocab in src/domain/vocab.js EVENT_TYPES (not a DB enum on purpose)
  actor_role      text not null,           -- borrower/coborrower/realtor/lo/processor/system
  actor_user_id   uuid references auth.users(id) on delete set null,
  payload         jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  unique (owner_user_id, idempotency_key)  -- retry-safe writes (projector/automations)
);
create index if not exists loan_events_file on public.loan_events (loan_file_id, created_at desc);
create index if not exists loan_events_owner_type on public.loan_events (owner_user_id, event_type, created_at desc);

alter table public.loan_events enable row level security;
-- Internal (owner/team) read only; borrower-safe events (if ever exposed) go through the gateway.
-- Owner path only here; team access is resolved in application code (resolveAccess), as elsewhere.
drop policy if exists "own loan_events" on public.loan_events;
create policy "own loan_events" on public.loan_events for select
  using (auth.uid() = owner_user_id);
-- No INSERT/UPDATE/DELETE policy => append-only via service role. Immutability guard (optional,
-- documented): a BEFORE UPDATE/DELETE trigger raising an exception would harden this further.

-- ---------------------------------------------------------------------------
-- notification_deliveries — persisted send record (closes audit gap R5).
-- ---------------------------------------------------------------------------
create table if not exists public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  loan_file_id    uuid references public.loan_files(id) on delete set null,
  channel         text not null check (channel in ('email','sms')),
  template_key    text not null,
  recipient       text not null,
  status          text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  provider_id     text,
  error           text,
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  unique (owner_user_id, idempotency_key)
);
create index if not exists notif_deliveries_file on public.notification_deliveries (loan_file_id, created_at desc);
create index if not exists notif_deliveries_owner_status on public.notification_deliveries (owner_user_id, status);

alter table public.notification_deliveries enable row level security;
drop policy if exists "own notification_deliveries" on public.notification_deliveries;
create policy "own notification_deliveries" on public.notification_deliveries for select
  using (auth.uid() = owner_user_id);

-- -- VERIFY (after a REAL apply) -------------------------------------------------
-- select count(*) from information_schema.tables
--   where table_schema='public' and table_name in ('loan_events','notification_deliveries'); -- expect 2
--
-- -- ROLLBACK -------------------------------------------------------------------
-- drop table if exists public.notification_deliveries;
-- drop table if exists public.loan_events;
