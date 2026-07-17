-- ============================================================================================
-- OURMTG PHASE 1C — OPERATIONAL PILOT MIGRATION (REVIEW SOURCE; NOT APPLIED)
-- Functional-completion revision. Apply only to an explicitly approved isolated branch database.
-- ============================================================================================
-- The RPCs are the database authority. They validate organization, participant, exact document
-- binding, lifecycle, revision and idempotency, then write task/history/event/intent atomically.
-- Browser roles cannot read the operational base tables or execute the SECURITY DEFINER RPCs.
-- ============================================================================================

create extension if not exists pgcrypto;

create or replace function public.ourmtg_raise_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'append-only table % is immutable (no % permitted)', tg_table_name, tg_op;
end $$;

create table if not exists public.organizations (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  legal_name   text not null,
  display_name text,
  status       text not null default 'active' check (status in ('active','suspended','closed')),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists t_organizations_upd on public.organizations;
create trigger t_organizations_upd before update on public.organizations
  for each row execute function set_updated_at();

create table if not exists public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id         uuid not null references auth.users(id) on delete restrict,
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

alter table public.loan_files
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;
create index if not exists loan_files_org on public.loan_files (organization_id);

-- Deterministic single-organization pilot backfill. This code is intentionally part of the
-- reviewable migration so an isolated-branch apply has a reproducible result, not an operator-
-- invented sequence. A conflicting WCC display name under another slug stops the migration.
do $$
begin
  if exists (
    select 1 from public.organizations
    where display_name = 'West Coast Capital Mortgage'
      and slug <> 'west-coast-capital-mortgage'
  ) then
    raise exception 'organization_preflight_conflict';
  end if;
end $$;

insert into public.organizations (slug, legal_name, display_name)
values ('west-coast-capital-mortgage', 'West Coast Capital Mortgage Inc.', 'West Coast Capital Mortgage')
on conflict (slug) do update
  set legal_name = excluded.legal_name,
      display_name = excluded.display_name,
      status = 'active',
      archived_at = null;

update public.loan_files lf
set organization_id = o.id
from public.organizations o
where o.slug = 'west-coast-capital-mortgage'
  and lf.organization_id is null;

insert into public.organization_members (organization_id, user_id, role, status)
select lf.organization_id, lf.owner_user_id, 'loan_officer', 'active'
from public.loan_files lf
where lf.organization_id is not null
on conflict (organization_id, user_id) do update
  set status = 'active',
      role = case
        when public.organization_members.role in ('owner','admin') then public.organization_members.role
        else 'loan_officer'
      end;

do $$
declare v_target uuid;
begin
  select id into strict v_target from public.organizations where slug = 'west-coast-capital-mortgage';
  if exists (select 1 from public.loan_files where organization_id is distinct from v_target) then
    raise exception 'loan_file_organization_backfill_incomplete';
  end if;
  if exists (
    select 1 from public.loan_files lf
    where not exists (
      select 1 from public.organization_members m
      where m.organization_id = lf.organization_id
        and m.user_id = lf.owner_user_id
        and m.status = 'active'
    )
  ) then
    raise exception 'owner_membership_backfill_incomplete';
  end if;
end $$;

alter table public.loan_files alter column organization_id set not null;

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
  request_hash     text,
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

create table if not exists public.loan_tasks (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete restrict,
  loan_file_id           uuid not null references public.loan_files(id) on delete restrict,
  task_type              text not null
                           check (task_type in ('document_request','document_reupload','condition','signature',
                                                'explanation','appointment','missing_page','information_request',
                                                'internal_review','other')),
  title                  text not null,
  borrower_explanation   text,
  internal_requirement   text,
  borrower_visible_status_reason text,
  responsible_party_type text not null
                           check (responsible_party_type in ('borrower','coborrower','loan_team','third_party','system')),
  responsible_user_id    uuid references auth.users(id) on delete restrict,
  shared_with_borrowers  boolean not null default false,
  required_document_id   uuid references public.loan_documents(id) on delete restrict,
  linked_document_id     uuid references public.loan_documents(id) on delete set null,
  status                 text not null default 'assigned'
                           check (status in ('created','assigned','viewed','in_progress','submitted','prechecked',
                                             'team_review','accepted','rejected','more_information_needed',
                                             'completed','reopened','cancelled')),
  revision               integer not null default 1 check (revision >= 0),
  priority               text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  is_blocking            boolean not null default false,
  due_at                 timestamptz,
  viewed_at              timestamptz,
  started_at             timestamptz,
  submitted_at           timestamptz,
  completed_at           timestamptz,
  reopened_at            timestamptz,
  archived_at            timestamptz,
  source_condition_id    uuid references public.loan_conditions(id) on delete set null,
  source_event_id        uuid references public.loan_events(id) on delete set null,
  required_document_type text,
  required_period_start  date,
  required_period_end    date,
  required_page_count    integer,
  metadata               jsonb not null default '{}'::jsonb,
  created_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint loan_tasks_audience_check check (
    (responsible_party_type in ('borrower','coborrower') and
      ((shared_with_borrowers and responsible_user_id is null) or
       (not shared_with_borrowers and responsible_user_id is not null)))
    or
    (responsible_party_type not in ('borrower','coborrower') and not shared_with_borrowers)
  ),
  constraint loan_tasks_document_requirement_check check (
    task_type not in ('document_request','document_reupload','missing_page')
    or required_document_id is not null
  )
);
create index if not exists loan_tasks_file on public.loan_tasks (loan_file_id, status);
create index if not exists loan_tasks_org on public.loan_tasks (organization_id, status, due_at);
create index if not exists loan_tasks_responsible on public.loan_tasks (responsible_user_id);
create index if not exists loan_tasks_required_doc on public.loan_tasks (required_document_id);
drop trigger if exists t_loan_tasks_upd on public.loan_tasks;
create trigger t_loan_tasks_upd before update on public.loan_tasks
  for each row execute function set_updated_at();

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

-- Canonical Phase 1B graph. Keep parity with src/domain/lifecycles.js and _lib/taskLifecycle.mjs.
create or replace function public.ourmtg_task_next_status(p_from text, p_action text)
  returns text language sql immutable as $$
  select case
    when p_action='assign' and p_from in ('created','reopened') then 'assigned'
    when p_action='view' and p_from='assigned' then 'viewed'
    when p_action='begin' and p_from in ('assigned','viewed','rejected','more_information_needed','reopened') then 'in_progress'
    when p_action='submit' and p_from in ('in_progress','more_information_needed') then 'submitted'
    when p_action='precheck' and p_from='submitted' then 'prechecked'
    when p_action='sendToTeamReview' and p_from in ('submitted','prechecked') then 'team_review'
    when p_action='accept' and p_from='team_review' then 'accepted'
    when p_action='reject' and p_from in ('submitted','prechecked','team_review') then 'rejected'
    when p_action='requestMoreInfo' and p_from in ('submitted','prechecked','team_review') then 'more_information_needed'
    when p_action='complete' and p_from='accepted' then 'completed'
    when p_action='reopen' and p_from in ('accepted','completed','rejected') then 'reopened'
    when p_action='cancel' and p_from in ('created','assigned','viewed','in_progress','submitted','prechecked','rejected','more_information_needed','reopened') then 'cancelled'
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

create or replace function public.ourmtg_task_role_allows(p_actor_type text, p_to_status text)
  returns boolean language sql immutable as $$
  select case
    when p_actor_type in ('loan_officer','processor','assistant') then true
    when p_actor_type in ('borrower','coborrower') then p_to_status in ('viewed','in_progress','submitted')
    when p_actor_type='system' then p_to_status in ('assigned','cancelled')
    else false end
$$;

-- Create + assign atomically. The user-facing task is actionable immediately, while both
-- created and assigned transitions remain in immutable history/events.
create or replace function public.ourmtg_task_create(
  p_organization_id uuid, p_loan_file_id uuid, p_task_type text, p_title text,
  p_borrower_explanation text, p_internal_requirement text,
  p_responsible_user_id uuid, p_shared_with_borrowers boolean,
  p_priority text, p_is_blocking boolean, p_due_at timestamptz,
  p_required_document_id uuid, p_required_document_type text,
  p_created_by uuid, p_actor_type text, p_actor_id uuid,
  p_source_system text, p_correlation_id text,
  p_idempotency_key text, p_request_hash text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task_id uuid; v_existing public.loan_events; v_loan public.loan_files;
  v_doc public.loan_documents; v_party text; v_now timestamptz := coalesce(p_at, now());
  v_recipient_role text;
begin
  if p_idempotency_key is null or p_request_hash is null then raise exception 'idempotency_required'; end if;
  select * into v_existing from public.loan_events
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key limit 1;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('ok',true,'deduped',true,'task_id',v_existing.source_record_id::uuid,
      'status',v_existing.new_state->>'status','revision',(v_existing.new_state->>'revision')::integer);
  end if;

  if p_actor_type not in ('loan_officer','processor','assistant')
     or p_actor_id is null or p_created_by is distinct from p_actor_id
     or p_source_system <> 'ourmtg' then
    raise exception 'forbidden_action';
  end if;

  select * into v_loan from public.loan_files where id=p_loan_file_id for share;
  if not found then raise exception 'loan_not_found'; end if;
  if v_loan.organization_id is distinct from p_organization_id then raise exception 'loan_org_mismatch'; end if;
  if not exists (select 1 from public.organization_members m where m.organization_id=p_organization_id
                 and m.user_id=p_actor_id and m.status='active') then raise exception 'forbidden_action'; end if;

  if coalesce(p_shared_with_borrowers,false) then
    if p_responsible_user_id is not null then raise exception 'audience_invalid'; end if;
    if not exists (select 1 from public.portal_access pa where pa.loan_file_id=p_loan_file_id
                   and pa.visibility in ('borrower','coborrower')) then raise exception 'participant_invalid'; end if;
    v_party := 'borrower';
    v_recipient_role := 'borrower_group';
  else
    if p_responsible_user_id is null then raise exception 'audience_invalid'; end if;
    select pa.visibility into v_party from public.portal_access pa
      where pa.loan_file_id=p_loan_file_id and pa.portal_user=p_responsible_user_id
        and pa.visibility in ('borrower','coborrower') limit 1;
    if v_party is null then raise exception 'participant_invalid'; end if;
    v_recipient_role := v_party;
  end if;

  if p_task_type in ('document_request','document_reupload','missing_page') then
    if p_required_document_id is null then raise exception 'required_document_missing'; end if;
    select * into v_doc from public.loan_documents where id=p_required_document_id for share;
    if not found or v_doc.loan_file_id<>p_loan_file_id then raise exception 'document_binding_mismatch'; end if;
    if not coalesce(p_shared_with_borrowers,false) and v_doc.who<>v_party then raise exception 'participant_invalid'; end if;
  end if;

  insert into public.loan_tasks(organization_id,loan_file_id,task_type,title,borrower_explanation,
    internal_requirement,responsible_party_type,responsible_user_id,shared_with_borrowers,
    required_document_id,status,revision,priority,is_blocking,due_at,required_document_type,created_by)
  values (p_organization_id,p_loan_file_id,p_task_type,p_title,p_borrower_explanation,
    p_internal_requirement,v_party,p_responsible_user_id,coalesce(p_shared_with_borrowers,false),
    p_required_document_id,'assigned',1,coalesce(p_priority,'normal'),coalesce(p_is_blocking,false),
    p_due_at,p_required_document_type,p_created_by)
  returning id into v_task_id;

  insert into public.loan_task_history(task_id,from_status,to_status,actor_type,actor_id,created_at)
    values (v_task_id,null,'created',p_actor_type,p_actor_id,v_now),
           (v_task_id,'created','assigned',p_actor_type,p_actor_id,v_now);
  insert into public.loan_events(organization_id,loan_file_id,event_type,actor_type,actor_id,source_system,
    source_record_id,correlation_id,idempotency_key,request_hash,previous_state,new_state,occurred_at)
    values
      (p_organization_id,p_loan_file_id,'task.created',p_actor_type,p_actor_id,p_source_system,
       v_task_id::text,p_correlation_id,p_idempotency_key,p_request_hash,null,
       jsonb_build_object('status','assigned','revision',1),v_now),
      (p_organization_id,p_loan_file_id,'task.assigned',p_actor_type,p_actor_id,p_source_system,
       v_task_id::text,p_correlation_id,'assign:'||p_idempotency_key,p_request_hash,
       jsonb_build_object('status','created','revision',0),jsonb_build_object('status','assigned','revision',1),v_now);
  insert into public.loan_events(organization_id,loan_file_id,event_type,actor_type,source_system,
    source_record_id,correlation_id,idempotency_key,metadata,occurred_at)
    values (p_organization_id,p_loan_file_id,'notification.queued','system',p_source_system,
      v_task_id::text,p_correlation_id,'intent:'||p_idempotency_key,
      jsonb_build_object('intent','borrower_task_created','recipient_role',v_recipient_role,'task_id',v_task_id::text),v_now);
  return jsonb_build_object('ok',true,'deduped',false,'task_id',v_task_id,'status','assigned','revision',1);
exception when unique_violation then
  select * into v_existing from public.loan_events
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key limit 1;
  if not found then raise; end if;
  if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('ok',true,'deduped',true,'task_id',v_existing.source_record_id::uuid,
    'status',v_existing.new_state->>'status','revision',(v_existing.new_state->>'revision')::integer);
end $$;

create or replace function public.ourmtg_task_transition(
  p_task_id uuid, p_action text, p_expected_revision integer,
  p_actor_type text, p_actor_id uuid, p_organization_id uuid,
  p_reason text, p_borrower_visible_reason text, p_evidence jsonb,
  p_idempotency_key text, p_request_hash text, p_correlation_id text,
  p_source_system text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task public.loan_tasks; v_loan public.loan_files; v_existing public.loan_events;
  v_from text; v_to text; v_evt text; v_intent text; v_new_revision integer;
  v_now timestamptz := coalesce(p_at,now()); v_recipient_role text;
begin
  if p_idempotency_key is null or p_request_hash is null then raise exception 'idempotency_required'; end if;
  select * into v_existing from public.loan_events
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key limit 1;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('ok',true,'deduped',true,'task_id',v_existing.source_record_id::uuid,
      'from',v_existing.previous_state->>'status','to',v_existing.new_state->>'status',
      'revision',(v_existing.new_state->>'revision')::integer);
  end if;

  if p_source_system <> 'ourmtg' then raise exception 'forbidden_action'; end if;
  select * into v_task from public.loan_tasks where id=p_task_id for update;
  if not found then raise exception 'task_not_found'; end if;
  select * into v_loan from public.loan_files where id=v_task.loan_file_id for share;
  if v_task.organization_id<>p_organization_id or v_loan.organization_id is distinct from p_organization_id
    then raise exception 'loan_org_mismatch'; end if;
  if v_task.revision<>p_expected_revision then raise exception 'stale_task'; end if;

  v_from := v_task.status;
  v_to := public.ourmtg_task_next_status(v_from,p_action);
  if v_to is null then raise exception 'invalid_transition'; end if;
  if not public.ourmtg_task_role_allows(p_actor_type,v_to) then raise exception 'forbidden_action'; end if;

  if p_actor_type in ('loan_officer','processor','assistant') then
    if not exists (select 1 from public.organization_members m where m.organization_id=p_organization_id
                   and m.user_id=p_actor_id and m.status='active') then raise exception 'forbidden_action'; end if;
  elsif p_actor_type in ('borrower','coborrower') then
    if not exists (select 1 from public.portal_access pa where pa.loan_file_id=v_task.loan_file_id
                   and pa.portal_user=p_actor_id and pa.visibility=p_actor_type) then raise exception 'not_participant'; end if;
    if not (v_task.shared_with_borrowers or v_task.responsible_user_id=p_actor_id) then raise exception 'not_participant'; end if;
  else
    raise exception 'forbidden_action';
  end if;

  if v_to='accepted' and v_task.task_type in ('document_request','document_reupload','condition','signature')
     and v_from<>'team_review' then raise exception 'review_required'; end if;
  if p_action in ('reject','requestMoreInfo','reopen')
     and (p_borrower_visible_reason is null or btrim(p_borrower_visible_reason)='') then raise exception 'reason_required'; end if;

  v_evt := public.ourmtg_task_event_type(p_action);
  v_new_revision := v_task.revision+1;
  update public.loan_tasks set
    status=v_to, revision=v_new_revision,
    borrower_visible_status_reason=case
      when p_action in ('reject','requestMoreInfo','reopen') then p_borrower_visible_reason
      when v_to in ('in_progress','submitted','accepted','completed') then null
      else borrower_visible_status_reason end,
    viewed_at=case when v_to='viewed' then coalesce(viewed_at,v_now) else viewed_at end,
    started_at=case when v_to='in_progress' then coalesce(started_at,v_now) else started_at end,
    submitted_at=case when v_to='submitted' then coalesce(submitted_at,v_now) else submitted_at end,
    completed_at=case when v_to='completed' then coalesce(completed_at,v_now) else completed_at end,
    reopened_at=case when v_to='reopened' then coalesce(reopened_at,v_now) else reopened_at end,
    updated_at=now()
  where id=p_task_id;

  insert into public.loan_task_history(task_id,from_status,to_status,actor_type,actor_id,reason,evidence,created_at)
    values (p_task_id,v_from,v_to,p_actor_type,p_actor_id,p_reason,p_evidence,v_now);
  insert into public.loan_events(organization_id,loan_file_id,event_type,actor_type,actor_id,source_system,
    source_record_id,correlation_id,idempotency_key,request_hash,previous_state,new_state,occurred_at)
    values (p_organization_id,v_task.loan_file_id,v_evt,p_actor_type,p_actor_id,p_source_system,
      p_task_id::text,p_correlation_id,p_idempotency_key,p_request_hash,
      jsonb_build_object('status',v_from,'revision',v_task.revision),
      jsonb_build_object('status',v_to,'revision',v_new_revision),v_now);

  v_intent := case p_action when 'reject' then 'borrower_task_rejected'
                 when 'requestMoreInfo' then 'borrower_task_more_information_needed'
                 when 'reopen' then 'borrower_task_reopened' else null end;
  v_recipient_role := case when v_task.shared_with_borrowers then 'borrower_group'
                           else v_task.responsible_party_type end;
  if v_intent is not null then
    insert into public.loan_events(organization_id,loan_file_id,event_type,actor_type,source_system,
      source_record_id,correlation_id,idempotency_key,metadata,occurred_at)
      values (p_organization_id,v_task.loan_file_id,'notification.queued','system',p_source_system,
        p_task_id::text,p_correlation_id,'intent:'||p_idempotency_key,
        jsonb_build_object('intent',v_intent,'recipient_role',v_recipient_role,'task_id',p_task_id::text),v_now);
  end if;
  return jsonb_build_object('ok',true,'deduped',false,'task_id',p_task_id,
    'from',v_from,'to',v_to,'revision',v_new_revision);
exception when unique_violation then
  select * into v_existing from public.loan_events
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key limit 1;
  if not found then raise; end if;
  if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('ok',true,'deduped',true,'task_id',v_existing.source_record_id::uuid,
    'from',v_existing.previous_state->>'status','to',v_existing.new_state->>'status',
    'revision',(v_existing.new_state->>'revision')::integer);
end $$;

create or replace function public.ourmtg_document_finalize_submit(
  p_document_id uuid, p_task_id uuid, p_organization_id uuid,
  p_actor_user_id uuid, p_actor_type text, p_expected_revision integer,
  p_idempotency_key text, p_request_hash text, p_correlation_id text,
  p_source_system text, p_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_doc public.loan_documents; v_task public.loan_tasks; v_loan public.loan_files;
  v_existing public.loan_events; v_visibility text; v_new_revision integer;
  v_now timestamptz := coalesce(p_at,now());
begin
  if p_idempotency_key is null or p_request_hash is null then raise exception 'idempotency_required'; end if;
  select * into v_existing from public.loan_events
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key limit 1;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('ok',true,'deduped',true,'task_id',v_existing.source_record_id::uuid,
      'document_id',(v_existing.metadata->>'document_id')::uuid,
      'to',v_existing.new_state->>'status','revision',(v_existing.new_state->>'revision')::integer);
  end if;

  if p_source_system <> 'ourmtg' or p_actor_type not in ('borrower','coborrower') then
    raise exception 'forbidden_action';
  end if;
  select * into v_doc from public.loan_documents where id=p_document_id for update;
  if not found then raise exception 'document_not_found'; end if;
  select * into v_task from public.loan_tasks where id=p_task_id for update;
  if not found then raise exception 'task_not_found'; end if;
  select * into v_loan from public.loan_files where id=v_task.loan_file_id for share;
  if v_task.organization_id<>p_organization_id or v_loan.organization_id is distinct from p_organization_id
    then raise exception 'loan_org_mismatch'; end if;
  if v_doc.loan_file_id<>v_task.loan_file_id then raise exception 'cross_loan_document'; end if;
  if v_task.required_document_id is distinct from p_document_id then raise exception 'document_binding_mismatch'; end if;
  if v_task.revision<>p_expected_revision then raise exception 'stale_task'; end if;
  if v_task.status<>'in_progress' then raise exception 'invalid_transition'; end if;

  select pa.visibility into v_visibility from public.portal_access pa
    where pa.loan_file_id=v_task.loan_file_id and pa.portal_user=p_actor_user_id
      and pa.visibility in ('borrower','coborrower') limit 1;
  if v_visibility is null or v_visibility <> p_actor_type then raise exception 'not_participant'; end if;
  if not (v_task.shared_with_borrowers or
          (v_task.responsible_user_id=p_actor_user_id and v_task.responsible_party_type=v_visibility))
    then raise exception 'not_participant'; end if;
  if not v_task.shared_with_borrowers and v_doc.who <> v_visibility then raise exception 'document_binding_mismatch'; end if;

  v_new_revision := v_task.revision+1;
  update public.loan_documents set status='uploaded', uploaded_at=v_now where id=p_document_id;
  update public.loan_tasks set status='submitted',revision=v_new_revision,linked_document_id=p_document_id,
    submitted_at=coalesce(submitted_at,v_now),borrower_visible_status_reason=null,updated_at=now()
    where id=p_task_id;
  insert into public.loan_task_history(task_id,from_status,to_status,actor_type,actor_id,created_at)
    values (p_task_id,'in_progress','submitted',p_actor_type,p_actor_user_id,v_now);
  insert into public.loan_events(organization_id,loan_file_id,event_type,actor_type,actor_id,source_system,
    source_record_id,correlation_id,idempotency_key,request_hash,previous_state,new_state,metadata,occurred_at)
    values (p_organization_id,v_task.loan_file_id,'task.submitted',p_actor_type,p_actor_user_id,p_source_system,
      p_task_id::text,p_correlation_id,p_idempotency_key,p_request_hash,
      jsonb_build_object('status','in_progress','revision',v_task.revision),
      jsonb_build_object('status','submitted','revision',v_new_revision),
      jsonb_build_object('document_id',p_document_id::text),v_now);
  insert into public.loan_events(organization_id,loan_file_id,event_type,actor_type,source_system,
    source_record_id,correlation_id,idempotency_key,metadata,occurred_at)
    values (p_organization_id,v_task.loan_file_id,'notification.queued','system',p_source_system,
      p_task_id::text,p_correlation_id,'intent:'||p_idempotency_key,
      jsonb_build_object('intent','borrower_document_submitted','recipient_role','loan_team','task_id',p_task_id::text),v_now);
  return jsonb_build_object('ok',true,'deduped',false,'task_id',p_task_id,
    'document_id',p_document_id,'to','submitted','revision',v_new_revision);
exception when unique_violation then
  select * into v_existing from public.loan_events
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key limit 1;
  if not found then raise; end if;
  if v_existing.request_hash is distinct from p_request_hash then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('ok',true,'deduped',true,'task_id',v_existing.source_record_id::uuid,
    'document_id',(v_existing.metadata->>'document_id')::uuid,
    'to',v_existing.new_state->>'status','revision',(v_existing.new_state->>'revision')::integer);
end $$;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.loan_events enable row level security;
alter table public.loan_tasks enable row level security;
alter table public.loan_task_history enable row level security;

revoke all on public.loan_tasks from anon, authenticated;
revoke all on public.loan_events from anon, authenticated;
revoke all on public.loan_task_history from anon, authenticated;
revoke all on public.organizations from anon, authenticated;
grant select on public.organization_members to authenticated;
drop policy if exists "member reads own membership" on public.organization_members;
create policy "member reads own membership" on public.organization_members for select
  using (auth.uid()=user_id);

revoke all on function public.ourmtg_task_create(uuid,uuid,text,text,text,text,uuid,boolean,text,boolean,timestamptz,uuid,text,uuid,text,uuid,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.ourmtg_task_create(uuid,uuid,text,text,text,text,uuid,boolean,text,boolean,timestamptz,uuid,text,uuid,text,uuid,text,text,text,text,timestamptz) to service_role;
revoke all on function public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,text,text,text,text,timestamptz) to service_role;
revoke all on function public.ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz) to service_role;

-- Post-apply acceptance queries (isolated branch only; migration remains unapplied here):
-- select count(*) from loan_files where organization_id is null; -- 0
-- select count(*) from loan_tasks t where not t.shared_with_borrowers and
--   not exists (select 1 from portal_access pa where pa.loan_file_id=t.loan_file_id
--               and pa.portal_user=t.responsible_user_id and pa.visibility=t.responsible_party_type); -- 0
-- select count(*) from loan_tasks t left join loan_documents d on d.id=t.required_document_id
--   where t.task_type in ('document_request','document_reupload','missing_page')
--     and (d.id is null or d.loan_file_id<>t.loan_file_id); -- 0
-- select has_table_privilege('authenticated','public.loan_tasks','SELECT'); -- false
--
-- Rollback is intentionally manual and dependency-ordered. Audit rows must be exported/retained;
-- do not hard-delete organizations/files/tasks with operational history.
