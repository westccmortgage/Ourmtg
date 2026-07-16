-- ============================================================================================
-- OURMTG PHASE 1C — OPERATIONAL PILOT MIGRATION (production-shaped; NOT YET APPLIED)
-- ============================================================================================
-- Promotes the MINIMUM entities for the task pilot: organizations, organization_members,
-- loan_events, loan_tasks, loan_task_history — plus two atomic RPCs (create + transition).
-- Reconciled against migrations 036–039. Reviewable location (docs/phase1c/migration/), NOT in
-- the auto-applied supabase/migrations/ sequence. Apply to a Supabase BRANCH only (see
-- OURMTG-TASK-PILOT-ACCEPTANCE.md). It does NOT touch existing portal/document/consent records.
--
-- This file is RUNNABLE (no guard) BUT is intentionally outside the migration sequence so it is
-- never auto-applied. Do NOT copy into supabase/migrations/ until owner approval + branch test.
-- Idempotent: create table/index if not exists; create or replace function.
-- ============================================================================================

-- Shared updated_at trigger fn is defined by 036 (create or replace there); reuse it.
-- Reusable append-only guard.
create or replace function public.ourmtg_raise_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'append-only table % is immutable (no % permitted)', tg_table_name, tg_op;
end $$;

-- A. organizations ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id           uuid primary key default gen_random_uuid(),
  legal_name   text not null,
  display_name text,
  status       text not null default 'active' check (status in ('active','suspended','closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists t_organizations_upd on public.organizations;
create trigger t_organizations_upd before update on public.organizations
  for each row execute function set_updated_at();

-- B. organization_members --------------------------------------------------------------------
create table if not exists public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null default 'member'
                    check (role in ('owner','admin','loan_officer','processor','assistant','member')),
  status          text not null default 'active' check (status in ('active','invited','disabled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists org_members_user on public.organization_members (user_id);
create index if not exists org_members_org on public.organization_members (organization_id);
drop trigger if exists t_org_members_upd on public.organization_members;
create trigger t_org_members_upd before update on public.organization_members
  for each row execute function set_updated_at();

-- C. loan_events (APPEND-ONLY, idempotent) ---------------------------------------------------
create table if not exists public.loan_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  loan_file_id     uuid not null references public.loan_files(id) on delete cascade,
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
create unique index if not exists loan_events_idem on public.loan_events (organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists loan_events_file on public.loan_events (loan_file_id, occurred_at desc);
create index if not exists loan_events_org_type on public.loan_events (organization_id, event_type, occurred_at desc);
create index if not exists loan_events_correlation on public.loan_events (correlation_id);
drop trigger if exists t_loan_events_immutable on public.loan_events;
create trigger t_loan_events_immutable before update or delete on public.loan_events
  for each row execute function public.ourmtg_raise_immutable();

-- D. loan_tasks ------------------------------------------------------------------------------
create table if not exists public.loan_tasks (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  loan_file_id           uuid not null references public.loan_files(id) on delete cascade,
  task_type              text not null,
  title                  text not null,
  borrower_explanation   text,
  internal_requirement   text,
  responsible_party_type text not null default 'borrower'
                           check (responsible_party_type in ('borrower','coborrower','loan_team','third_party','system')),
  responsible_user_id    uuid references auth.users(id) on delete set null,
  status                 text not null default 'created'
                           check (status in ('created','assigned','viewed','in_progress','submitted','prechecked',
                                             'team_review','accepted','rejected','more_information_needed',
                                             'completed','reopened','cancelled')),
  priority               text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  is_blocking            boolean not null default false,
  due_at                 timestamptz,
  viewed_at              timestamptz,
  started_at             timestamptz,
  submitted_at           timestamptz,
  completed_at           timestamptz,
  reopened_at            timestamptz,
  source_condition_id    uuid references public.loan_conditions(id) on delete set null,
  source_event_id        uuid references public.loan_events(id) on delete set null,
  linked_document_id     uuid references public.loan_documents(id) on delete set null,
  required_document_type text,
  required_period_start  date,
  required_period_end    date,
  required_page_count    integer,
  metadata               jsonb not null default '{}'::jsonb,
  created_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists loan_tasks_file on public.loan_tasks (loan_file_id, status);
create index if not exists loan_tasks_org on public.loan_tasks (organization_id, status, due_at);
create index if not exists loan_tasks_responsible on public.loan_tasks (responsible_user_id);
drop trigger if exists t_loan_tasks_upd on public.loan_tasks;
create trigger t_loan_tasks_upd before update on public.loan_tasks
  for each row execute function set_updated_at();

-- E. loan_task_history (APPEND-ONLY) ---------------------------------------------------------
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
  for each row execute function public.ourmtg_raise_immutable();

-- ---------- ATOMIC RPCs (task + history + event in ONE transaction) ----------
-- SECURITY DEFINER: invoked only by the service-role gateway after it authorizes the actor and
-- verifies loan-file + organization access in code (the pure Phase 1B task service validates the
-- transition BEFORE this is called). These functions do the atomic persistence and re-check the
-- org boundary. Any failure RAISES (no silent swallowing) and rolls back all three writes.

create or replace function public.ourmtg_task_create(
  p_organization_id uuid, p_loan_file_id uuid, p_task_type text, p_title text,
  p_borrower_explanation text, p_internal_requirement text, p_responsible_party_type text,
  p_responsible_user_id uuid, p_priority text, p_is_blocking boolean, p_due_at timestamptz,
  p_required_document_type text, p_created_by uuid, p_actor_type text, p_actor_id uuid,
  p_source_system text, p_correlation_id text, p_idempotency_key text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task_id uuid;
begin
  if p_idempotency_key is not null then
    perform 1 from public.loan_events where organization_id = p_organization_id and idempotency_key = p_idempotency_key;
    if found then return jsonb_build_object('ok', true, 'deduped', true); end if;
  end if;
  insert into public.loan_tasks(organization_id, loan_file_id, task_type, title, borrower_explanation,
    internal_requirement, responsible_party_type, responsible_user_id, status, priority, is_blocking,
    due_at, required_document_type, created_by)
  values (p_organization_id, p_loan_file_id, p_task_type, p_title, p_borrower_explanation,
    p_internal_requirement, coalesce(p_responsible_party_type,'borrower'), p_responsible_user_id,
    'created', coalesce(p_priority,'normal'), coalesce(p_is_blocking,false), p_due_at,
    p_required_document_type, p_created_by)
  returning id into v_task_id;

  insert into public.loan_task_history(task_id, from_status, to_status, actor_type, actor_id, reason, evidence)
    values (v_task_id, null, 'created', p_actor_type, p_actor_id, null, null);

  insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type, actor_id,
    source_system, source_record_id, correlation_id, idempotency_key, previous_state, new_state, metadata, occurred_at)
    values (p_organization_id, p_loan_file_id, 'task.created', p_actor_type, p_actor_id, p_source_system,
      v_task_id::text, p_correlation_id, p_idempotency_key, null, jsonb_build_object('status','created'),
      '{}'::jsonb, coalesce(p_at, now()));

  return jsonb_build_object('ok', true, 'deduped', false, 'task_id', v_task_id);
end $$;

create or replace function public.ourmtg_task_transition(
  p_task_id uuid, p_to_status text, p_actor_type text, p_actor_id uuid, p_organization_id uuid,
  p_reason text, p_evidence jsonb, p_event_type text, p_linked_document_id uuid,
  p_idempotency_key text, p_correlation_id text, p_source_system text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task public.loan_tasks; v_from text;
begin
  if p_idempotency_key is not null then
    perform 1 from public.loan_events where organization_id = p_organization_id and idempotency_key = p_idempotency_key;
    if found then return jsonb_build_object('ok', true, 'deduped', true); end if;
  end if;

  select * into v_task from public.loan_tasks where id = p_task_id for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.organization_id <> p_organization_id then raise exception 'org_mismatch'; end if;
  v_from := v_task.status;

  update public.loan_tasks set
    status = p_to_status,
    linked_document_id = coalesce(p_linked_document_id, linked_document_id),
    viewed_at    = case when p_to_status='viewed'      then coalesce(viewed_at, p_at)    else viewed_at end,
    started_at   = case when p_to_status='in_progress' then coalesce(started_at, p_at)   else started_at end,
    submitted_at = case when p_to_status='submitted'   then coalesce(submitted_at, p_at) else submitted_at end,
    completed_at = case when p_to_status='completed'   then coalesce(completed_at, p_at) else completed_at end,
    reopened_at  = case when p_to_status='reopened'    then coalesce(reopened_at, p_at)  else reopened_at end,
    updated_at   = now()
  where id = p_task_id;

  insert into public.loan_task_history(task_id, from_status, to_status, actor_type, actor_id, reason, evidence)
    values (p_task_id, v_from, p_to_status, p_actor_type, p_actor_id, p_reason, p_evidence);

  insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type, actor_id,
    source_system, source_record_id, correlation_id, idempotency_key, previous_state, new_state, metadata, occurred_at)
    values (p_organization_id, v_task.loan_file_id, p_event_type, p_actor_type, p_actor_id, p_source_system,
      p_task_id::text, p_correlation_id, p_idempotency_key, jsonb_build_object('status', v_from),
      jsonb_build_object('status', p_to_status), '{}'::jsonb, coalesce(p_at, now()));

  return jsonb_build_object('ok', true, 'deduped', false, 'from', v_from, 'to', p_to_status);
end $$;

-- ---------- RLS ----------
alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.loan_events          enable row level security;
alter table public.loan_tasks           enable row level security;
alter table public.loan_task_history    enable row level security;

-- Members read their own membership; org read via membership.
drop policy if exists "member reads own membership" on public.organization_members;
create policy "member reads own membership" on public.organization_members for select
  using (auth.uid() = user_id);
drop policy if exists "member reads own org" on public.organizations;
create policy "member reads own org" on public.organizations for select
  using (exists (select 1 from public.organization_members m
                 where m.organization_id = organizations.id and m.user_id = auth.uid() and m.status = 'active'));

-- Borrower reads ONLY their own borrower-facing tasks (with a portal_access grant). internal_
-- requirement is never sent to borrowers by the API regardless (see gateway). No borrower policy
-- exposes internal fields — RLS grants row read; the gateway column-scopes.
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
-- loan_events / loan_task_history: NO borrower SELECT policy (internal-only; default-deny).
-- Team/org reads and all writes go through the service-role gateway + the RPCs above.

-- ---------- BACKFILL PLAN (run deliberately on a branch; NOT auto-run) ----------
-- 1) Create the pilot organization:
--    insert into public.organizations (legal_name, display_name)
--      values ('West Coast Capital Mortgage Inc.', 'West Coast Capital Mortgage')
--      on conflict do nothing;
-- 2) Map existing loan-file owners to membership (explicit, NOT from email domain):
--    insert into public.organization_members (organization_id, user_id, role)
--      select o.id, lf.owner_user_id, 'loan_officer'
--        from public.organizations o
--        cross join (select distinct owner_user_id from public.loan_files) lf
--       where o.display_name = 'West Coast Capital Mortgage'
--      on conflict (organization_id, user_id) do nothing;
-- 3) (Optional) Tag existing loan_files with the org via a future loan_files.organization_id
--    column — NOT added here to avoid altering the existing table in the pilot. Pilot tasks
--    carry organization_id directly; the gateway resolves a file's org via membership + a
--    single-org assumption for this pilot deployment.
-- Existing portal_users / portal_access / loan_documents / loan_conditions / portal_consent
-- rows are NOT modified.

-- ---------- VALIDATION QUERIES (after a branch apply) ----------
-- select count(*) from information_schema.tables where table_schema='public'
--   and table_name in ('organizations','organization_members','loan_events','loan_tasks','loan_task_history'); -- expect 5
-- select proname from pg_proc where proname in ('ourmtg_task_create','ourmtg_task_transition'); -- expect 2
-- -- immutability: expect an exception
-- -- update public.loan_events set event_type='x' where false;  (trigger raises on any real row)

-- ---------- ROLLBACK (reverse dependency order) ----------
-- drop function if exists public.ourmtg_task_transition(uuid,text,text,uuid,uuid,text,jsonb,text,uuid,text,text,text,timestamptz);
-- drop function if exists public.ourmtg_task_create(uuid,uuid,text,text,text,text,text,uuid,text,boolean,timestamptz,text,uuid,text,uuid,text,text,text,timestamptz);
-- drop table if exists public.loan_task_history;
-- drop table if exists public.loan_tasks;
-- drop table if exists public.loan_events;
-- drop table if exists public.organization_members;
-- drop table if exists public.organizations;
-- drop function if exists public.ourmtg_raise_immutable();
