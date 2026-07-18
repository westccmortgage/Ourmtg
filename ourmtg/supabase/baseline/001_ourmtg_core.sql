-- OurMtg clean core baseline
-- Primary Supabase project: diqukqhbmqcheffhensp
--
-- First usable workflow:
--   approved loan-team user creates a loan file
--   -> invites borrower / co-borrower
--   -> requests an exact document
--   -> borrower uploads to private Storage
--   -> loan team accepts, rejects, or requests another copy
--   -> both sides see status and portal history
--
-- This is the single source for a fresh OurMtg core schema. It intentionally excludes
-- the experimental Phase 1C organization/task migration (043), environment rehearsals,
-- AI actions, disclosure delivery, SMS delivery, and Arive synchronization.

begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- One borrower-safe row per loan file. GRCRM/Arive may populate source_deal_id later;
-- manual files use a server-generated manual_* value.
create table if not exists public.loan_files (
  id                  uuid primary key default gen_random_uuid(),
  owner_user_id       uuid not null references auth.users(id) on delete cascade,
  source_deal_id      text not null,
  loan_number         text,
  borrower_name       text not null,
  realtor_contact_id  text,
  loan_type           text,
  purpose             text,
  stage               text not null default 'lead',
  amount              numeric check (amount is null or amount >= 0),
  est_close_date      date,
  preapproval_amount  numeric check (preapproval_amount is null or preapproval_amount >= 0),
  preapproval_expires date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_user_id, source_deal_id)
);
create index if not exists loan_files_owner
  on public.loan_files (owner_user_id, updated_at desc);
alter table public.loan_files enable row level security;
drop trigger if exists t_loan_files_upd on public.loan_files;
create trigger t_loan_files_upd
  before update on public.loan_files
  for each row execute function public.set_updated_at();

-- External portal identity. The user id is the Supabase Auth user id.
create table if not exists public.portal_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null,
  full_name  text,
  email      text,
  phone      text,
  created_at timestamptz not null default now()
);
alter table public.portal_users drop constraint if exists portal_users_role_check;
alter table public.portal_users add constraint portal_users_role_check
  check (role in ('borrower','coborrower','realtor','escrow','title'));
alter table public.portal_users enable row level security;
drop policy if exists "own portal_user" on public.portal_users;
create policy "own portal_user" on public.portal_users
  for select using (auth.uid() = id);

-- Explicit loan-file grants. Only service-role functions create or change grants.
create table if not exists public.portal_access (
  id           uuid primary key default gen_random_uuid(),
  portal_user  uuid not null references auth.users(id) on delete cascade,
  loan_file_id uuid not null references public.loan_files(id) on delete cascade,
  visibility   text not null default 'borrower',
  created_at   timestamptz not null default now(),
  unique (portal_user, loan_file_id)
);
alter table public.portal_access drop constraint if exists portal_access_visibility_check;
alter table public.portal_access add constraint portal_access_visibility_check
  check (visibility in ('borrower','coborrower','realtor','escrow','title'));
create index if not exists portal_access_user on public.portal_access (portal_user);
create index if not exists portal_access_file on public.portal_access (loan_file_id);
alter table public.portal_access enable row level security;
drop policy if exists "own portal_access" on public.portal_access;
create policy "own portal_access" on public.portal_access
  for select using (auth.uid() = portal_user);

-- Processor / assistant access to all files owned by one approved loan officer.
create table if not exists public.portal_team (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  role           text not null default 'processor'
                 check (role in ('processor','assistant')),
  created_at     timestamptz not null default now(),
  unique (owner_user_id, member_user_id)
);
create index if not exists portal_team_member on public.portal_team (member_user_id);
create index if not exists portal_team_owner on public.portal_team (owner_user_id);
alter table public.portal_team enable row level security;
drop policy if exists "own portal_team member" on public.portal_team;
create policy "own portal_team member" on public.portal_team
  for select using (auth.uid() = member_user_id);
drop policy if exists "own portal_team owner" on public.portal_team;
create policy "own portal_team owner" on public.portal_team
  for select using (auth.uid() = owner_user_id);

-- Identity-bound, expiring, single-use invitations.
create table if not exists public.portal_invites (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  role          text not null,
  token         text unique not null,
  email         text,
  phone         text,
  name          text,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
alter table public.portal_invites drop constraint if exists portal_invites_role_check;
alter table public.portal_invites add constraint portal_invites_role_check
  check (role in ('borrower','coborrower','realtor','escrow','title'));
create index if not exists portal_invites_token on public.portal_invites (token);
create index if not exists portal_invites_owner
  on public.portal_invites (owner_user_id, created_at desc);
create index if not exists portal_invites_file on public.portal_invites (loan_file_id);
alter table public.portal_invites enable row level security;
drop policy if exists "own portal_invites" on public.portal_invites;
create policy "own portal_invites" on public.portal_invites
  for select using (auth.uid() = owner_user_id);

-- The document request itself is the core task for version one.
create table if not exists public.loan_documents (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  doc_key       text not null,
  label         text not null,
  who           text not null default 'borrower'
                check (who in ('borrower','coborrower')),
  status        text not null default 'requested'
                check (status in ('requested','uploaded','accepted','rejected')),
  storage_path  text,
  reject_reason text,
  requested_at  timestamptz not null default now(),
  uploaded_at   timestamptz,
  reviewed_at   timestamptz
);
create index if not exists loan_documents_file
  on public.loan_documents (loan_file_id, requested_at);
alter table public.loan_documents enable row level security;
drop policy if exists "portal read docs" on public.loan_documents;
create policy "portal read docs" on public.loan_documents
  for select using (
    exists (
      select 1
      from public.portal_access pa
      where pa.loan_file_id = loan_documents.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );

create table if not exists public.loan_conditions (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  detail        text,
  status        text not null default 'open'
                check (status in ('open','submitted','cleared')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists loan_conditions_file on public.loan_conditions (loan_file_id);
alter table public.loan_conditions enable row level security;
drop trigger if exists t_loan_conditions_upd on public.loan_conditions;
create trigger t_loan_conditions_upd
  before update on public.loan_conditions
  for each row execute function public.set_updated_at();
drop policy if exists "portal read conditions" on public.loan_conditions;
create policy "portal read conditions" on public.loan_conditions
  for select using (
    exists (
      select 1
      from public.portal_access pa
      where pa.loan_file_id = loan_conditions.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );

-- Borrower-visible history and two-way portal messages.
create table if not exists public.loan_messages (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  direction     text not null check (direction in ('in','out')),
  author_role   text not null,
  body          text not null,
  channel       text not null default 'portal',
  created_at    timestamptz not null default now()
);
create index if not exists loan_messages_file
  on public.loan_messages (loan_file_id, created_at desc);
alter table public.loan_messages enable row level security;
drop policy if exists "portal read messages" on public.loan_messages;
create policy "portal read messages" on public.loan_messages
  for select using (
    exists (
      select 1
      from public.portal_access pa
      where pa.loan_file_id = loan_messages.loan_file_id
        and pa.portal_user = auth.uid()
        and pa.visibility in ('borrower','coborrower')
    )
  );

create table if not exists public.portal_consent (
  id           uuid primary key default gen_random_uuid(),
  portal_user  uuid references auth.users(id) on delete set null,
  loan_file_id uuid references public.loan_files(id) on delete set null,
  consent_type text not null,
  granted      boolean not null,
  ip           text,
  user_agent   text,
  text_shown   text,
  created_at   timestamptz not null default now()
);
create index if not exists portal_consent_user
  on public.portal_consent (portal_user, created_at desc);
alter table public.portal_consent enable row level security;
drop policy if exists "own portal_consent" on public.portal_consent;
create policy "own portal_consent" on public.portal_consent
  for select using (auth.uid() = portal_user);

create table if not exists public.portal_access_log (
  id           uuid primary key default gen_random_uuid(),
  portal_user  uuid references auth.users(id) on delete set null,
  loan_file_id uuid references public.loan_files(id) on delete set null,
  action       text not null,
  target       text,
  ip           text,
  created_at   timestamptz not null default now()
);
create index if not exists portal_access_log_user
  on public.portal_access_log (portal_user, created_at desc);
create index if not exists portal_access_log_file
  on public.portal_access_log (loan_file_id, created_at desc);
alter table public.portal_access_log enable row level security;
drop policy if exists "own portal_access_log" on public.portal_access_log;
create policy "own portal_access_log" on public.portal_access_log
  for select using (auth.uid() = portal_user);

-- Retained for future LO-approved WCCI summaries. There is deliberately no browser
-- SELECT policy on this table because RLS cannot hide the raw payload column.
create table if not exists public.loan_strategy (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source        text not null default 'wcci',
  payload       jsonb not null,
  summary       text,
  status        text not null default 'draft'
                check (status in ('draft','approved','hidden')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  approved_at   timestamptz
);
create index if not exists loan_strategy_file on public.loan_strategy (loan_file_id);
alter table public.loan_strategy enable row level security;
drop trigger if exists t_loan_strategy_upd on public.loan_strategy;
create trigger t_loan_strategy_upd
  before update on public.loan_strategy
  for each row execute function public.set_updated_at();
drop policy if exists "portal read approved strategy" on public.loan_strategy;

create table if not exists public.site_settings (
  id         text primary key default 'default',
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;
drop policy if exists "public read site_settings" on public.site_settings;
create policy "public read site_settings" on public.site_settings
  for select using (true);

insert into public.site_settings (id, data)
values ('default', jsonb_build_object(
  'rate', 7,
  'loanTypes', jsonb_build_array('Conventional','FHA','VA','Jumbo','USDA','Non-QM','DSCR'),
  'home', jsonb_build_object(
    'headline', 'the mortgage,',
    'headlineAlt', 'minus the noise.',
    'sub', 'One secure link: upload documents from your phone, watch your loan move stage by stage, and always know what''s next.'
  )
))
on conflict (id) do nothing;

-- Operational visibility for the optional GRCRM projector.
create table if not exists public.cron_heartbeat (
  name       text primary key,
  last_run   timestamptz not null default now(),
  note       text,
  updated_at timestamptz not null default now()
);
alter table public.cron_heartbeat enable row level security;

-- Financial documents always live in a private bucket. Browser users receive only
-- short-lived signed URLs from authorized server functions.
insert into storage.buckets (id, name, public)
values ('ourmtg-docs', 'ourmtg-docs', false)
on conflict (id) do update set public = false;
drop policy if exists "ourmtg-docs public read" on storage.objects;

commit;
