-- ============================================================================================
-- OURMTG PHASE 1B — OPERATIONAL SCHEMA (DRAFT — DO NOT APPLY)
-- ============================================================================================
-- Guarded, non-runnable planning artifact. Lives OUTSIDE supabase/migrations/ and carries NO
-- runnable sequence number. It introduces the explicit organization_id tenancy boundary the
-- owner mandated (do not finalize on owner_user_id alone). Nothing here is applied in Phase 1B.
--
-- Design invariants:
--   • Every operational table carries organization_id (tenant) + FKs to existing tables.
--   • loan_events and loan_task_history are APPEND-ONLY (SELECT-only RLS + immutability trigger).
--   • RLS enabled on all; borrower/partner exposure is column-scoped via the server gateway,
--     never a broad borrower SELECT of internal tables.
--   • Idempotency: loan_events unique (organization_id, idempotency_key) when key present.
--   • Reconcile-then-apply: when made real, review FKs against live 036–039 and backfill a
--     default organization mapping owner_user_id → organizations before enforcing NOT NULL.
-- ============================================================================================
DO $$ BEGIN
  RAISE EXCEPTION 'OURMTG Phase 1B DRAFT schema — not for execution. Author real supabase/migrations only after owner approval and org backfill.';
END $$;

-- Reusable immutability guard for append-only tables.
create or replace function ourmtg_raise_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'append-only table % is immutable', tg_table_name;
end $$;

-- A. organizations -----------------------------------------------------------------------------
create table if not exists public.organizations (
  id           uuid primary key default gen_random_uuid(),
  legal_name   text not null,
  display_name text,
  status       text not null default 'active' check (status in ('active','suspended','closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- B. organization_members ----------------------------------------------------------------------
create table if not exists public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner','admin','loan_officer','processor','assistant','member')),
  status          text not null default 'active' check (status in ('active','invited','disabled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists org_members_user on public.organization_members (user_id);
create index if not exists org_members_org on public.organization_members (organization_id);

-- C. loan_events (APPEND-ONLY, idempotent) -----------------------------------------------------
create table if not exists public.loan_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  loan_file_id     uuid references public.loan_files(id) on delete set null,
  event_type       text not null,
  actor_type       text not null,
  actor_id         uuid references auth.users(id) on delete set null,
  source_system    text not null,
  source_record_id text,
  correlation_id   text,
  idempotency_key  text,
  previous_state   jsonb,
  new_state        jsonb,
  metadata         jsonb not null default '{}'::jsonb,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create unique index if not exists loan_events_idem on public.loan_events (organization_id, idempotency_key) where idempotency_key is not null;
create index if not exists loan_events_file on public.loan_events (loan_file_id, occurred_at desc);
create index if not exists loan_events_org_type on public.loan_events (organization_id, event_type, occurred_at desc);
create index if not exists loan_events_correlation on public.loan_events (correlation_id);
drop trigger if exists t_loan_events_immutable on public.loan_events;
create trigger t_loan_events_immutable before update or delete on public.loan_events
  for each row execute function ourmtg_raise_immutable();

-- D. loan_tasks --------------------------------------------------------------------------------
create table if not exists public.loan_tasks (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  loan_file_id          uuid not null references public.loan_files(id) on delete cascade,
  task_type             text not null,
  title                 text not null,
  borrower_explanation  text,
  internal_requirement  text,
  responsible_party_type text not null default 'borrower' check (responsible_party_type in ('borrower','coborrower','loan_team','third_party','system')),
  responsible_user_id   uuid references auth.users(id) on delete set null,
  status                text not null default 'created',
  priority              text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  is_blocking           boolean not null default false,
  due_at                timestamptz,
  viewed_at             timestamptz,
  started_at            timestamptz,
  submitted_at          timestamptz,
  completed_at          timestamptz,
  reopened_at           timestamptz,
  source_condition_id   uuid references public.loan_conditions(id) on delete set null,
  source_event_id       uuid references public.loan_events(id) on delete set null,
  required_document_type text,
  required_period_start date,
  required_period_end   date,
  required_page_count   integer,
  metadata              jsonb not null default '{}'::jsonb,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists loan_tasks_file on public.loan_tasks (loan_file_id, status);
create index if not exists loan_tasks_org on public.loan_tasks (organization_id, status, due_at);
create index if not exists loan_tasks_responsible on public.loan_tasks (responsible_user_id);

-- E. loan_task_history (APPEND-ONLY) -----------------------------------------------------------
create table if not exists public.loan_task_history (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.loan_tasks(id) on delete cascade,
  from_status text,
  to_status   text not null,
  actor_type  text not null,
  actor_id    uuid references auth.users(id) on delete set null,
  reason      text,
  evidence    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists loan_task_history_task on public.loan_task_history (task_id, created_at);
drop trigger if exists t_loan_task_history_immutable on public.loan_task_history;
create trigger t_loan_task_history_immutable before update or delete on public.loan_task_history
  for each row execute function ourmtg_raise_immutable();

-- F. loan_milestones ---------------------------------------------------------------------------
create table if not exists public.loan_milestones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  loan_file_id     uuid not null references public.loan_files(id) on delete cascade,
  milestone_type   text not null,
  status           text not null default 'pending' check (status in ('pending','in_progress','completed','blocked','skipped')),
  expected_at      timestamptz,
  completed_at     timestamptz,
  source_system    text,
  source_record_id text,
  borrower_visible boolean not null default true,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (loan_file_id, milestone_type)
);
create index if not exists loan_milestones_file on public.loan_milestones (loan_file_id);

-- G. cash_to_close_items -----------------------------------------------------------------------
create table if not exists public.cash_to_close_items (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  loan_file_id         uuid not null references public.loan_files(id) on delete cascade,
  category             text not null,
  label                text not null,
  amount               numeric,
  amount_low           numeric,
  amount_high          numeric,
  classification       text not null default 'estimated' check (classification in ('illustrative','estimated','verified','final')),
  source_type          text,
  source_document_id   uuid references public.loan_documents(id) on delete set null,
  source_page          integer,
  as_of_date           date,
  verified             boolean not null default false,
  confidence           numeric,
  borrower_explanation text,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists ctc_items_file on public.cash_to_close_items (loan_file_id, category);

-- H. cash_to_close_snapshots -------------------------------------------------------------------
create table if not exists public.cash_to_close_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  loan_file_id       uuid not null references public.loan_files(id) on delete cascade,
  planning_total     numeric,
  verified_total     numeric,
  final_total        numeric,
  cash_identified    numeric,
  estimated_shortfall numeric,
  source_summary     jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists ctc_snapshots_file on public.cash_to_close_snapshots (loan_file_id, created_at desc);

-- I. disclosure_packages (tracking only — NOT an e-sign provider) ------------------------------
create table if not exists public.disclosure_packages (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  loan_file_id        uuid not null references public.loan_files(id) on delete cascade,
  provider            text,
  external_package_id text,
  package_type        text,
  status              text not null default 'prepared' check (status in ('prepared','sent','provider_accepted','delivered','bounced','opened','viewed','partially_signed','completed','expired','resend_required')),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  opened_at           timestamptz,
  partially_signed_at timestamptz,
  completed_at        timestamptz,
  expired_at          timestamptz,
  resend_required     boolean not null default false,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists disclosure_pkgs_file on public.disclosure_packages (loan_file_id, status);

-- J. third_party_items (appraisal / title / escrow / insurance) --------------------------------
create table if not exists public.third_party_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  loan_file_id     uuid not null references public.loan_files(id) on delete cascade,
  item_type        text not null check (item_type in ('appraisal','title','escrow','insurance')),
  status           text not null default 'not_started' check (status in ('not_started','ordered','scheduled','in_progress','received','completed','delayed','cancelled')),
  assigned_party   text,
  ordered_at       timestamptz,
  scheduled_at     timestamptz,
  expected_at      timestamptz,
  received_at      timestamptz,
  completed_at     timestamptz,
  borrower_visible boolean not null default true,
  blocker_reason   text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists third_party_items_file on public.third_party_items (loan_file_id, item_type);

-- ---------- RLS: enable everywhere; SELECT-only for the authenticated role ----------
-- Internal reads resolve org membership in application code (like resolveAccess today). Borrower
-- exposure is column-scoped through the server gateway, not a broad SELECT of these tables.
alter table public.organizations         enable row level security;
alter table public.organization_members  enable row level security;
alter table public.loan_events           enable row level security;
alter table public.loan_tasks            enable row level security;
alter table public.loan_task_history     enable row level security;
alter table public.loan_milestones       enable row level security;
alter table public.cash_to_close_items   enable row level security;
alter table public.cash_to_close_snapshots enable row level security;
alter table public.disclosure_packages   enable row level security;
alter table public.third_party_items     enable row level security;

drop policy if exists "org member reads own org" on public.organization_members;
create policy "org member reads own org" on public.organization_members for select
  using (auth.uid() = user_id);
-- Borrower-visible tasks (audience/responsible = borrower) readable by a borrower/coborrower grant.
drop policy if exists "borrower reads own tasks" on public.loan_tasks;
create policy "borrower reads own tasks" on public.loan_tasks for select
  using (
    responsible_party_type in ('borrower','coborrower') and exists (
      select 1 from public.portal_access pa
      where pa.loan_file_id = loan_tasks.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );
-- Borrower-visible milestones.
drop policy if exists "borrower reads visible milestones" on public.loan_milestones;
create policy "borrower reads visible milestones" on public.loan_milestones for select
  using (
    borrower_visible and exists (
      select 1 from public.portal_access pa
      where pa.loan_file_id = loan_milestones.loan_file_id and pa.portal_user = auth.uid()
    )
  );
-- Borrower-visible cash-to-close (borrower/coborrower only).
drop policy if exists "borrower reads ctc items" on public.cash_to_close_items;
create policy "borrower reads ctc items" on public.cash_to_close_items for select
  using (
    exists (
      select 1 from public.portal_access pa
      where pa.loan_file_id = cash_to_close_items.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );
-- Third-party items: borrower/partner see milestone-level via gateway; a borrower-visible flag
-- gates a direct read for borrowers with a grant. No financial detail is stored here.
drop policy if exists "borrower reads visible third party" on public.third_party_items;
create policy "borrower reads visible third party" on public.third_party_items for select
  using (
    borrower_visible and exists (
      select 1 from public.portal_access pa
      where pa.loan_file_id = third_party_items.loan_file_id and pa.portal_user = auth.uid()
    )
  );
-- loan_events / loan_task_history / cash_to_close_snapshots / disclosure_packages / organizations:
-- NO borrower SELECT policy (internal-only; RLS default-deny). Access via the service gateway.

-- ---------- VERIFY (after a REAL apply) ----------
-- select count(*) from information_schema.tables where table_schema='public' and table_name in (
--   'organizations','organization_members','loan_events','loan_tasks','loan_task_history',
--   'loan_milestones','cash_to_close_items','cash_to_close_snapshots','disclosure_packages',
--   'third_party_items');  -- expect 10

-- ---------- ROLLBACK (reverse dependency order) ----------
-- drop table if exists public.third_party_items;
-- drop table if exists public.disclosure_packages;
-- drop table if exists public.cash_to_close_snapshots;
-- drop table if exists public.cash_to_close_items;
-- drop table if exists public.loan_milestones;
-- drop table if exists public.loan_task_history;
-- drop table if exists public.loan_tasks;
-- drop table if exists public.loan_events;
-- drop table if exists public.organization_members;
-- drop table if exists public.organizations;
-- drop function if exists ourmtg_raise_immutable();
