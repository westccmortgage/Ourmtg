-- ============================================================================================
-- OURMTG PHASE 1C — OPERATIONAL PILOT MIGRATION (production-shaped; NOT YET APPLIED)
-- Rev 2 — external-review hardening (EXT-1..EXT-13). Apply to a Supabase BRANCH only.
-- ============================================================================================
-- The RPCs are the SERVER-SIDE AUTHORITY: they revalidate the transition graph, enforce
-- optimistic-concurrency via a revision, derive the event type themselves (never trust a
-- caller-supplied status/event), enforce idempotency by a request hash, and write the task,
-- history, event and notification-intent atomically. Only service_role may EXECUTE them. The
-- base operational tables are NOT selectable by anon/authenticated — borrower reads go through
-- the authenticated Netlify gateway. Audit tables (loan_events, loan_task_history) are append-only
-- and protected from cascade erasure.
--
-- Reviewable location (docs/phase1c/migration/), OUTSIDE supabase/migrations/ so it is never
-- auto-applied. Runnable on a branch (no guard). See OURMTG-TASK-PILOT-ACCEPTANCE.md.
-- ============================================================================================

-- set_updated_at() is defined by migration 036 (create or replace there); reuse it.
create or replace function public.ourmtg_raise_immutable() returns trigger language plpgsql as $$
begin raise exception 'append-only table % is immutable (no % permitted)', tg_table_name, tg_op; end $$;

-- ============================================================================================
-- A. organizations (EXT-1/EXT-13: slug with a UNIQUE constraint — the deterministic key)
-- ============================================================================================
create table if not exists public.organizations (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  legal_name   text not null,
  display_name text,
  status       text not null default 'active' check (status in ('active','suspended','closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists t_organizations_upd on public.organizations;
create trigger t_organizations_upd before update on public.organizations
  for each row execute function set_updated_at();

-- ============================================================================================
-- B. organization_members (a user may belong to MANY organizations — EXT-1)
-- ============================================================================================
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

-- ============================================================================================
-- EXT-1: loan_files gains organization_id (additive; nullable until backfilled). The gateway
-- resolves a file's org from THIS column.
-- ============================================================================================
alter table public.loan_files add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
create index if not exists loan_files_org on public.loan_files (organization_id);

-- ============================================================================================
-- C. loan_events (APPEND-ONLY, idempotent). EXT-12: NO cascade from org/file — audit survives.
-- ============================================================================================
create table if not exists public.loan_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  loan_file_id     uuid not null references public.loan_files(id) on delete restrict,
  event_type       text not null,
  actor_type       text not null,
  actor_id         uuid references auth.users(id) on delete set null,
  source_system    text not null,
  source_record_id text,
  correlation_id   text,
  idempotency_key  text,
  request_hash     text,            -- EXT-8: canonical material-payload hash
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

-- ============================================================================================
-- D. loan_tasks. EXT-4: revision (optimistic concurrency). EXT-6: borrower_visible_status_reason.
-- EXT-7: participant targeting (responsible_user_id + shared_with_borrowers). EXT-12: no cascade
-- from org/file; soft-archive via archived_at.
-- ============================================================================================
create table if not exists public.loan_tasks (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete restrict,
  loan_file_id           uuid not null references public.loan_files(id) on delete restrict,
  task_type              text not null,
  title                  text not null,
  borrower_explanation   text,
  internal_requirement   text,
  borrower_visible_status_reason text,   -- EXT-6
  responsible_party_type text not null default 'borrower'
                           check (responsible_party_type in ('borrower','coborrower','loan_team','third_party','system')),
  responsible_user_id    uuid references auth.users(id) on delete set null,   -- EXT-7 specific participant
  shared_with_borrowers  boolean not null default false,                      -- EXT-7 shared audience
  status                 text not null default 'created'
                           check (status in ('created','assigned','viewed','in_progress','submitted','prechecked',
                                             'team_review','accepted','rejected','more_information_needed',
                                             'completed','reopened','cancelled')),
  revision               integer not null default 0,        -- EXT-4 optimistic concurrency
  priority               text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  is_blocking            boolean not null default false,
  due_at                 timestamptz,
  viewed_at              timestamptz,
  started_at             timestamptz,
  submitted_at           timestamptz,
  completed_at           timestamptz,
  reopened_at            timestamptz,
  archived_at            timestamptz,     -- EXT-12 soft archive (controlled retention)
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

-- ============================================================================================
-- E. loan_task_history (APPEND-ONLY). EXT-12: RESTRICT on task delete — history is never erased
-- by deleting a task (delete is blocked; use soft-archive).
-- ============================================================================================
create table if not exists public.loan_task_history (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.loan_tasks(id) on delete restrict,
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

-- ============================================================================================
-- SERVER-SIDE STATE MACHINE (EXT-4) — the DB owns the graph, the to-status, and the event type.
-- ============================================================================================
create or replace function public.ourmtg_task_next_status(p_from text, p_action text)
  returns text language sql immutable as $$
  select case
    when p_action='assign'          and p_from in ('created','reopened')                                   then 'assigned'
    when p_action='view'            and p_from in ('assigned')                                             then 'viewed'
    when p_action='begin'           and p_from in ('assigned','viewed','rejected','more_information_needed','reopened') then 'in_progress'
    when p_action='submit'          and p_from in ('in_progress','more_information_needed')                then 'submitted'
    when p_action='precheck'        and p_from in ('submitted')                                            then 'prechecked'
    when p_action='sendToTeamReview' and p_from in ('submitted','prechecked')                             then 'team_review'
    when p_action='accept'          and p_from in ('team_review')                                          then 'accepted'
    when p_action='reject'          and p_from in ('submitted','prechecked','team_review','rejected')      then 'rejected'
    when p_action='requestMoreInfo' and p_from in ('submitted','prechecked','team_review')                then 'more_information_needed'
    when p_action='complete'        and p_from in ('accepted')                                            then 'completed'
    when p_action='reopen'          and p_from in ('accepted','completed','rejected')                     then 'reopened'
    when p_action='cancel'          and p_from in ('created','assigned','viewed','in_progress','submitted','prechecked','rejected','more_information_needed','reopened') then 'cancelled'
    else null end
$$;

create or replace function public.ourmtg_task_event_type(p_action text)
  returns text language sql immutable as $$
  select case p_action
    when 'assign' then 'task.assigned' when 'view' then 'task.viewed' when 'begin' then 'task.started'
    when 'submit' then 'task.submitted' when 'precheck' then 'task.prechecked'
    when 'sendToTeamReview' then 'task.team_review' when 'accept' then 'task.accepted'
    when 'reject' then 'task.rejected' when 'requestMoreInfo' then 'task.more_information_needed'
    when 'complete' then 'task.completed' when 'reopen' then 'task.reopened' when 'cancel' then 'task.cancelled'
    else null end
$$;

-- Server-side role guard (EXT-3: don't trust a browser actor — but only service_role can call,
-- and the gateway sets actor from the JWT; this is defense-in-depth).
create or replace function public.ourmtg_task_role_allows(p_actor_type text, p_to_status text)
  returns boolean language sql immutable as $$
  select case
    when p_actor_type in ('loan_officer','processor','assistant') then true
    when p_actor_type in ('borrower','coborrower') then p_to_status in ('viewed','in_progress','submitted')
    when p_actor_type = 'system' then p_to_status in ('assigned','cancelled')
    else false end
$$;

-- ============================================================================================
-- RPC: create (atomic task + history + event + notification-intent). EXT-8 idempotency+hash.
-- ============================================================================================
create or replace function public.ourmtg_task_create(
  p_organization_id uuid, p_loan_file_id uuid, p_task_type text, p_title text,
  p_borrower_explanation text, p_internal_requirement text, p_responsible_party_type text,
  p_responsible_user_id uuid, p_shared_with_borrowers boolean, p_priority text, p_is_blocking boolean,
  p_due_at timestamptz, p_required_document_type text, p_created_by uuid, p_actor_type text, p_actor_id uuid,
  p_source_system text, p_correlation_id text, p_idempotency_key text, p_request_hash text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task_id uuid; v_existing public.loan_events;
begin
  if p_idempotency_key is null then raise exception 'idempotency_required'; end if;
  -- EXT-8: same key → compare request hash. Same payload returns the original; different → conflict.
  select * into v_existing from public.loan_events
    where organization_id = p_organization_id and idempotency_key = p_idempotency_key limit 1;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('ok', true, 'deduped', true, 'task_id', v_existing.source_record_id::uuid);
  end if;

  insert into public.loan_tasks(organization_id, loan_file_id, task_type, title, borrower_explanation,
    internal_requirement, responsible_party_type, responsible_user_id, shared_with_borrowers, status,
    priority, is_blocking, due_at, required_document_type, created_by)
  values (p_organization_id, p_loan_file_id, p_task_type, p_title, p_borrower_explanation,
    p_internal_requirement, coalesce(p_responsible_party_type,'borrower'), p_responsible_user_id,
    coalesce(p_shared_with_borrowers,false), 'created', coalesce(p_priority,'normal'),
    coalesce(p_is_blocking,false), p_due_at, p_required_document_type, p_created_by)
  returning id into v_task_id;

  insert into public.loan_task_history(task_id, from_status, to_status, actor_type, actor_id)
    values (v_task_id, null, 'created', p_actor_type, p_actor_id);
  insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type, actor_id,
    source_system, source_record_id, correlation_id, idempotency_key, request_hash, new_state, occurred_at)
    values (p_organization_id, p_loan_file_id, 'task.created', p_actor_type, p_actor_id, p_source_system,
      v_task_id::text, p_correlation_id, p_idempotency_key, p_request_hash,
      jsonb_build_object('status','created'), coalesce(p_at, now()));
  -- EXT-9: notification INTENT written IN this transaction, deterministically keyed (no send).
  insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type,
    source_system, source_record_id, correlation_id, idempotency_key, metadata, occurred_at)
    values (p_organization_id, p_loan_file_id, 'notification.queued', 'system', p_source_system,
      v_task_id::text, p_correlation_id, 'intent:'||p_idempotency_key,
      jsonb_build_object('intent','borrower_task_created','recipient_role','borrower','task_id',v_task_id::text),
      coalesce(p_at, now()));

  return jsonb_build_object('ok', true, 'deduped', false, 'task_id', v_task_id);
exception when unique_violation then
  -- FCG #5: a concurrent retry won the idempotency-key race; reuse that committed operation.
  select * into v_existing from public.loan_events
    where organization_id = p_organization_id and idempotency_key = p_idempotency_key limit 1;
  if found and v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('ok', true, 'deduped', true, 'task_id', v_existing.source_record_id::uuid);
end $$;

-- ============================================================================================
-- RPC: transition (EXT-4 revision + in-tx revalidation + server-derived event; EXT-6 reason;
-- EXT-8 hash; EXT-9 in-tx intent). Caller passes p_action + p_expected_revision (NOT a status).
-- ============================================================================================
create or replace function public.ourmtg_task_transition(
  p_task_id uuid, p_action text, p_expected_revision integer, p_actor_type text, p_actor_id uuid,
  p_organization_id uuid, p_reason text, p_borrower_visible_reason text, p_evidence jsonb,
  p_linked_document_id uuid, p_idempotency_key text, p_request_hash text, p_correlation_id text,
  p_source_system text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task public.loan_tasks; v_from text; v_to text; v_evt text; v_existing public.loan_events; v_intent text;
begin
  if p_idempotency_key is null then raise exception 'idempotency_required'; end if;
  select * into v_existing from public.loan_events
    where organization_id = p_organization_id and idempotency_key = p_idempotency_key limit 1;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('ok', true, 'deduped', true);
  end if;

  select * into v_task from public.loan_tasks where id = p_task_id for update;   -- EXT-4 lock
  if not found then raise exception 'task_not_found'; end if;
  if v_task.organization_id <> p_organization_id then raise exception 'org_mismatch'; end if;
  if v_task.revision <> p_expected_revision then raise exception 'stale_task'; end if;  -- EXT-4
  v_from := v_task.status;

  v_to := public.ourmtg_task_next_status(v_from, p_action);                       -- EXT-4 revalidate
  if v_to is null then raise exception 'invalid_transition'; end if;
  if not public.ourmtg_task_role_allows(p_actor_type, v_to) then raise exception 'forbidden_action'; end if;
  if v_to = 'accepted' and v_task.task_type in ('document_request','document_reupload','condition','signature')
     and v_from <> 'team_review' then raise exception 'review_required'; end if;
  -- FCG-2.5 / EXT-6: a reject or more-information transition CANNOT complete without a borrower-visible
  -- reason. Defense-in-depth: the gateway already enforces this, but the RPC is the authority so the
  -- rule holds even if a caller bypasses the gateway.
  if v_to in ('rejected','more_information_needed')
     and (p_borrower_visible_reason is null or btrim(p_borrower_visible_reason) = '') then
    raise exception 'reason_required';
  end if;
  v_evt := public.ourmtg_task_event_type(p_action);                              -- EXT-4 derive event

  update public.loan_tasks set
    status = v_to, revision = revision + 1,
    linked_document_id = coalesce(p_linked_document_id, linked_document_id),
    -- EXT-6: set the borrower-visible reason on reject/more-info; clear it when the borrower
    -- re-engages (submit/in_progress) or the item is accepted/completed.
    borrower_visible_status_reason = case
      when v_to in ('rejected','more_information_needed') then p_borrower_visible_reason
      when v_to in ('submitted','in_progress','accepted','completed') then null
      else borrower_visible_status_reason end,
    viewed_at    = case when v_to='viewed'      then coalesce(viewed_at, p_at)    else viewed_at end,
    started_at   = case when v_to='in_progress' then coalesce(started_at, p_at)   else started_at end,
    submitted_at = case when v_to='submitted'   then coalesce(submitted_at, p_at) else submitted_at end,
    completed_at = case when v_to='completed'   then coalesce(completed_at, p_at) else completed_at end,
    reopened_at  = case when v_to='reopened'    then coalesce(reopened_at, p_at)  else reopened_at end,
    updated_at   = now()
  where id = p_task_id;

  insert into public.loan_task_history(task_id, from_status, to_status, actor_type, actor_id, reason, evidence)
    values (p_task_id, v_from, v_to, p_actor_type, p_actor_id, p_reason, p_evidence);
  insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type, actor_id,
    source_system, source_record_id, correlation_id, idempotency_key, request_hash, previous_state, new_state, occurred_at)
    values (p_organization_id, v_task.loan_file_id, v_evt, p_actor_type, p_actor_id, p_source_system,
      p_task_id::text, p_correlation_id, p_idempotency_key, p_request_hash,
      jsonb_build_object('status', v_from), jsonb_build_object('status', v_to), coalesce(p_at, now()));

  -- EXT-9: borrower notification INTENT for reject / more-info, in-tx + deterministically keyed.
  v_intent := case v_to when 'rejected' then 'borrower_task_rejected'
                        when 'more_information_needed' then 'borrower_task_more_information_needed' else null end;
  if v_intent is not null then
    insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type, source_system,
      source_record_id, correlation_id, idempotency_key, metadata, occurred_at)
      values (p_organization_id, v_task.loan_file_id, 'notification.queued', 'system', p_source_system,
        p_task_id::text, p_correlation_id, 'intent:'||p_idempotency_key,
        jsonb_build_object('intent',v_intent,'recipient_role','borrower','task_id',p_task_id::text),
        coalesce(p_at, now()));
  end if;

  return jsonb_build_object('ok', true, 'deduped', false, 'from', v_from, 'to', v_to, 'revision', v_task.revision + 1);
exception when unique_violation then
  -- FCG #5: a concurrent retry won the idempotency-key race; reuse that committed operation.
  select * into v_existing from public.loan_events
    where organization_id = p_organization_id and idempotency_key = p_idempotency_key limit 1;
  if found and v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('ok', true, 'deduped', true);
end $$;

-- ============================================================================================
-- RPC: document finalize + submit (EXT-5). ONE transaction: validate relationship + participant,
-- mark document uploaded, link to task, transition task to submitted, history + event + intent.
-- Storage existence is verified by the gateway BEFORE calling this (fail-closed). Any failure
-- here rolls back everything.
-- ============================================================================================
create or replace function public.ourmtg_document_finalize_submit(
  p_document_id uuid, p_task_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_actor_type text,
  p_expected_revision integer, p_idempotency_key text, p_request_hash text, p_correlation_id text,
  p_source_system text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_doc public.loan_documents; v_task public.loan_tasks; v_existing public.loan_events;
begin
  if p_idempotency_key is null then raise exception 'idempotency_required'; end if;
  select * into v_existing from public.loan_events
    where organization_id = p_organization_id and idempotency_key = p_idempotency_key limit 1;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('ok', true, 'deduped', true);
  end if;

  select * into v_doc from public.loan_documents where id = p_document_id for update;
  if not found then raise exception 'document_not_found'; end if;
  select * into v_task from public.loan_tasks where id = p_task_id for update;
  if not found then raise exception 'task_not_found'; end if;
  -- Relationship + org + participant + document-binding validation (all must line up or roll back).
  if v_task.organization_id <> p_organization_id then raise exception 'org_mismatch'; end if;
  if v_doc.loan_file_id <> v_task.loan_file_id then raise exception 'cross_loan_document'; end if;
  if v_task.responsible_party_type not in ('borrower','coborrower') then raise exception 'not_borrower_task'; end if;
  -- FCG #2/#7: the acting user must be the task's targeted participant (specific borrower/co-borrower),
  -- or the task is shared with all borrowers, or it is untargeted. One borrower cannot finalize a task
  -- targeted at another borrower.
  if not (v_task.shared_with_borrowers or v_task.responsible_user_id is null or v_task.responsible_user_id = p_actor_user_id)
    then raise exception 'not_participant'; end if;
  -- FCG #3/#7: a document task binds to ONE exact document. Once a document is linked, finalizing a
  -- DIFFERENT document against the same task is rejected (no silent re-binding).
  if v_task.linked_document_id is not null and v_task.linked_document_id <> p_document_id
    then raise exception 'document_binding_mismatch'; end if;
  if v_task.revision <> p_expected_revision then raise exception 'stale_task'; end if;
  -- FCG #1: the borrower document finalize is the borrower's single submit action and is executable
  -- from any borrower-actionable pre-submission state (mirrors borrowerMustAct). The plain 'submit'
  -- transition graph (ourmtg_task_next_status) is unchanged; only this document-driven submit broadens.
  if v_task.status not in ('created','assigned','viewed','in_progress','rejected','more_information_needed','reopened')
    then raise exception 'invalid_transition'; end if;

  update public.loan_documents set status = 'uploaded', uploaded_at = coalesce(p_at, now()) where id = p_document_id;
  update public.loan_tasks set status = 'submitted', revision = revision + 1, linked_document_id = p_document_id,
    submitted_at = coalesce(submitted_at, p_at), borrower_visible_status_reason = null, updated_at = now()
    where id = p_task_id;
  insert into public.loan_task_history(task_id, from_status, to_status, actor_type, actor_id)
    values (p_task_id, v_task.status, 'submitted', p_actor_type, p_actor_user_id);
  insert into public.loan_events(organization_id, loan_file_id, event_type, actor_type, actor_id,
    source_system, source_record_id, correlation_id, idempotency_key, request_hash, previous_state, new_state, metadata, occurred_at)
    values (p_organization_id, v_task.loan_file_id, 'task.submitted', p_actor_type, p_actor_user_id, p_source_system,
      p_task_id::text, p_correlation_id, p_idempotency_key, p_request_hash,
      jsonb_build_object('status', v_task.status), jsonb_build_object('status','submitted'),
      jsonb_build_object('document_id', p_document_id::text), coalesce(p_at, now()));
  return jsonb_build_object('ok', true, 'deduped', false, 'task_id', p_task_id, 'document_id', p_document_id);
exception when unique_violation then
  -- FCG #5: a concurrent retry won the idempotency-key race; reuse that committed operation.
  select * into v_existing from public.loan_events
    where organization_id = p_organization_id and idempotency_key = p_idempotency_key limit 1;
  if found and v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('ok', true, 'deduped', true, 'task_id', p_task_id, 'document_id', p_document_id);
end $$;

-- ============================================================================================
-- EXT-2: base operational tables are NOT selectable by anon/authenticated (borrower reads go
-- through the authenticated gateway). RLS stays enabled as defense-in-depth.
-- ============================================================================================
alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.loan_events          enable row level security;
alter table public.loan_tasks           enable row level security;
alter table public.loan_task_history    enable row level security;

revoke all on public.loan_tasks        from anon, authenticated;
revoke all on public.loan_events       from anon, authenticated;
revoke all on public.loan_task_history from anon, authenticated;
revoke all on public.organizations     from anon, authenticated;
-- Members may read their own membership rows (needed for org resolution) — SELECT only.
grant select on public.organization_members to authenticated;
drop policy if exists "member reads own membership" on public.organization_members;
create policy "member reads own membership" on public.organization_members for select
  using (auth.uid() = user_id);

-- ============================================================================================
-- EXT-3: SECURITY DEFINER RPCs — lock down execution to service_role ONLY.
-- ============================================================================================
do $$ declare fn text; begin
  foreach fn in array array[
    'ourmtg_task_create(uuid,uuid,text,text,text,text,text,uuid,boolean,text,boolean,timestamptz,text,uuid,text,uuid,text,text,text,text,timestamptz)',
    'ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,uuid,text,text,text,text,timestamptz)',
    'ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('revoke all on function public.%s from anon', fn);
    execute format('revoke all on function public.%s from authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- ============================================================================================
-- EXT-13: DETERMINISTIC ORGANIZATION BACKFILL (run deliberately on a branch; NOT auto-run).
-- Slug is the stable conflict target. Preflight stops clearly on a duplicate/mismatch.
-- ============================================================================================
-- 1) PREFLIGHT — a display_name collision under a DIFFERENT slug must stop, not pick arbitrarily:
--    do $$ begin
--      if exists (select 1 from public.organizations
--                 where display_name = 'West Coast Capital Mortgage' and slug <> 'west-coast-capital-mortgage')
--      then raise exception 'preflight: a WCC org exists under a different slug — reconcile before backfill'; end if;
--    end $$;
-- 2) DETERMINISTIC UPSERT by slug (the unique key):
--    insert into public.organizations (slug, legal_name, display_name)
--      values ('west-coast-capital-mortgage','West Coast Capital Mortgage Inc.','West Coast Capital Mortgage')
--      on conflict (slug) do update set legal_name = excluded.legal_name, display_name = excluded.display_name;
-- 3) MEMBERSHIP backfill (existing loan-file owners → loan_officer):
--    insert into public.organization_members (organization_id, user_id, role)
--      select o.id, lf.owner_user_id, 'loan_officer'
--        from public.organizations o
--        join (select distinct owner_user_id from public.loan_files) lf on true
--       where o.slug = 'west-coast-capital-mortgage'
--      on conflict (organization_id, user_id) do nothing;
-- 4) loan_files.organization_id backfill (single pilot org):
--    update public.loan_files lf set organization_id = o.id
--      from public.organizations o where o.slug = 'west-coast-capital-mortgage' and lf.organization_id is null;
-- 5) NULL / MISMATCH report — ORGANIZATION-SCOPED (FCG #8). Validation is bound to the TARGET org
--    (slug 'west-coast-capital-mortgage'); a membership in some OTHER org does not count as backfilled.
--    All checks must be zero before enabling flags.
--    with target as (select id from public.organizations where slug = 'west-coast-capital-mortgage')
--    -- (a) files not assigned to THE target org (null OR assigned elsewhere):
--    select count(*) as files_not_in_target_org from public.loan_files lf
--      where lf.organization_id is distinct from (select id from target);                          -- expect 0
--    -- (b) owners of target-org files lacking an ACTIVE membership IN THE TARGET ORG:
--    with target as (select id from public.organizations where slug = 'west-coast-capital-mortgage')
--    select count(*) as owners_without_target_membership from (
--      select distinct lf.owner_user_id from public.loan_files lf
--      where lf.organization_id = (select id from target)
--      and not exists (select 1 from public.organization_members m
--                      where m.user_id = lf.owner_user_id
--                        and m.organization_id = (select id from target)
--                        and m.status = 'active')) t;                                              -- expect 0

-- ---------- VALIDATION QUERIES (after a branch apply) ----------
-- select count(*) from information_schema.tables where table_schema='public'
--   and table_name in ('organizations','organization_members','loan_events','loan_tasks','loan_task_history'); -- 5
-- select proname from pg_proc where proname in ('ourmtg_task_create','ourmtg_task_transition','ourmtg_document_finalize_submit'); -- 3
-- select has_table_privilege('authenticated','public.loan_tasks','SELECT');   -- expect false (EXT-2)
-- select has_function_privilege('authenticated','public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,uuid,text,text,text,text,timestamptz)','EXECUTE'); -- expect false (EXT-3)

-- ---------- ROLLBACK (reverse dependency order) ----------
-- drop function if exists public.ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz);
-- drop function if exists public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,uuid,text,text,text,text,timestamptz);
-- drop function if exists public.ourmtg_task_create(uuid,uuid,text,text,text,text,text,uuid,boolean,text,boolean,timestamptz,text,uuid,text,uuid,text,text,text,text,timestamptz);
-- drop function if exists public.ourmtg_task_role_allows(text,text);
-- drop function if exists public.ourmtg_task_event_type(text);
-- drop function if exists public.ourmtg_task_next_status(text,text);
-- drop table if exists public.loan_task_history;
-- drop table if exists public.loan_tasks;
-- drop table if exists public.loan_events;
-- drop table if exists public.organization_members;
-- alter table public.loan_files drop column if exists organization_id;
-- drop table if exists public.organizations;
-- drop function if exists public.ourmtg_raise_immutable();
