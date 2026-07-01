-- ============================================================
-- 036 — OurMTG portal schema (row-scoped, borrower/Realtor-facing PROJECTION).
--
-- WHY THIS EXISTS
--   GRCRM stores each broker's contacts/deals as ONE big JSON array inside that
--   broker's app_state row. There is no per-borrower row to secure, so a borrower
--   can never be given RLS access to app_state without seeing the whole book of
--   business. OurMTG therefore reads a PROJECTION: one row per loan file, scoped by
--   RLS to exactly the borrower / co-borrower / Realtor entitled to it.
--
--   GRCRM stays the source of truth. sync-loan-file.mjs (service role) WRITES these
--   tables from wcci-deals; portal users only ever READ them (RLS). All external
--   writes (uploads, messages, consent) go through the OurMTG server gateway using
--   the service role — there are deliberately NO insert/update policies for the
--   authenticated role on the data tables.
--
-- SECURITY MODEL
--   • portal_users  — external identities (borrower/coborrower/realtor). They ARE
--     Supabase auth.users (magic link) but are NEVER granted CRM (app_state) access.
--   • portal_access — the grant that links a portal user to a loan file + visibility.
--   • Realtors are STRUCTURALLY blocked from documents & conditions (policy checks
--     visibility in ('borrower','coborrower')). This is enforced in the DB, not the UI.
--   • Financial documents live in the PRIVATE 'ourmtg-docs' bucket (public = false).
--     Access is only ever via short-lived signed URLs minted server-side after a
--     portal_access check. The public 'crm-media' bucket is never used for these.
--   • WCCI strategy is a DRAFT until an LO approves it: borrowers can only read
--     loan_strategy rows with status='approved' (enforced by RLS, not app logic).
--
-- Safe to re-run (idempotent-ish): create-if-not-exists + drop/create policies.
-- ============================================================

create extension if not exists pgcrypto;

-- Reuse the shared updated_at toucher from schema.sql (defined there). Re-declare
-- defensively so this migration can run standalone against a fresh DB.
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ── loan_files ────────────────────────────────────────────────────────────────
-- The borrower-safe view of ONE GRCRM deal.
--   owner_user_id  = the broker (GRCRM auth.users.id) whose wcci-deals holds the deal
--   source_deal_id = the deal's id inside that broker's wcci-deals array
-- Dedupe key: (owner_user_id, source_deal_id). Repeat projections UPDATE in place.
create table if not exists public.loan_files (
  id                  uuid primary key default gen_random_uuid(),
  owner_user_id       uuid not null references auth.users(id) on delete cascade,
  source_deal_id      text not null,
  loan_number         text,
  borrower_name       text,
  realtor_contact_id  text,
  loan_type           text,                       -- Conventional/FHA/VA/Jumbo/...
  purpose             text,                       -- Purchase / Rate-Term Refi / Cash-out Refi / HELOC
  stage               text not null default 'lead', -- mirrors pipeline: lead..funded
  amount              numeric,
  est_close_date      date,
  -- LO-controlled, Realtor-visible fields. The projector NEVER overwrites these;
  -- only the LO sets them via the portal admin, so borrower/Realtor exposure stays
  -- under human control.
  preapproval_amount  numeric,
  preapproval_expires date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_user_id, source_deal_id)
);
create index if not exists loan_files_owner on public.loan_files(owner_user_id, updated_at desc);
alter table public.loan_files enable row level security;
drop trigger if exists t_loan_files_upd on public.loan_files;
create trigger t_loan_files_upd before update on public.loan_files
  for each row execute function set_updated_at();

-- ── portal_users ──────────────────────────────────────────────────────────────
create table if not exists public.portal_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('borrower','coborrower','realtor')),
  full_name   text,
  email       text,
  phone       text,
  created_at  timestamptz not null default now()
);
alter table public.portal_users enable row level security;
drop policy if exists "own portal_user" on public.portal_users;
create policy "own portal_user" on public.portal_users
  for select using (auth.uid() = id);

-- ── portal_access ─────────────────────────────────────────────────────────────
-- Which portal user may read which loan file, and at what visibility.
create table if not exists public.portal_access (
  id            uuid primary key default gen_random_uuid(),
  portal_user   uuid not null references auth.users(id) on delete cascade,
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  visibility    text not null default 'borrower'
                 check (visibility in ('borrower','coborrower','realtor')),
  created_at    timestamptz not null default now(),
  unique (portal_user, loan_file_id)
);
create index if not exists portal_access_user on public.portal_access(portal_user);
create index if not exists portal_access_file on public.portal_access(loan_file_id);
alter table public.portal_access enable row level security;
-- A portal user may read their OWN grants (so the app can list their files).
drop policy if exists "own portal_access" on public.portal_access;
create policy "own portal_access" on public.portal_access
  for select using (auth.uid() = portal_user);
-- Writes (granting access) are service-role only — no authenticated write policy.

-- ── loan_documents ────────────────────────────────────────────────────────────
-- Document requests + uploads. `doc_key` drives the checklist; `status` its state.
create table if not exists public.loan_documents (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  doc_key       text not null,              -- 'paystub_30d','bank_2mo','w2_2yr','id_front',...
  label         text not null,
  who           text not null default 'borrower' check (who in ('borrower','coborrower')),
  status        text not null default 'requested'
                 check (status in ('requested','uploaded','accepted','rejected')),
  storage_path  text,                       -- ourmtg-docs/<owner>/<loan_file>/<uuid>
  reject_reason text,
  requested_at  timestamptz not null default now(),
  uploaded_at   timestamptz,
  reviewed_at   timestamptz
);
create index if not exists loan_documents_file on public.loan_documents(loan_file_id);
alter table public.loan_documents enable row level security;
-- Borrower/co-borrower read their file's documents. Realtors NEVER (visibility gate).
drop policy if exists "portal read docs" on public.loan_documents;
create policy "portal read docs" on public.loan_documents for select using (
  exists (
    select 1 from public.portal_access pa
    where pa.loan_file_id = loan_documents.loan_file_id
      and pa.portal_user  = auth.uid()
      and pa.visibility in ('borrower','coborrower')
  )
);

-- ── loan_conditions ───────────────────────────────────────────────────────────
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
create index if not exists loan_conditions_file on public.loan_conditions(loan_file_id);
alter table public.loan_conditions enable row level security;
drop trigger if exists t_loan_conditions_upd on public.loan_conditions;
create trigger t_loan_conditions_upd before update on public.loan_conditions
  for each row execute function set_updated_at();
-- Borrower/co-borrower only. Realtors never see condition detail.
drop policy if exists "portal read conditions" on public.loan_conditions;
create policy "portal read conditions" on public.loan_conditions for select using (
  exists (
    select 1 from public.portal_access pa
    where pa.loan_file_id = loan_conditions.loan_file_id
      and pa.portal_user  = auth.uid()
      and pa.visibility in ('borrower','coborrower')
  )
);

-- ── loan_messages ─────────────────────────────────────────────────────────────
-- Portal messages (borrower/realtor <-> team). Outbound-to-external is LO-approved
-- at the gateway; the table itself just stores the record. Realtors may read.
create table if not exists public.loan_messages (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  direction     text not null check (direction in ('in','out')),
  author_role   text not null,              -- borrower/realtor/lo/processor/system
  body          text not null,
  channel       text not null default 'portal', -- portal/sms/email
  created_at    timestamptz not null default now()
);
create index if not exists loan_messages_file on public.loan_messages(loan_file_id, created_at desc);
alter table public.loan_messages enable row level security;
drop policy if exists "portal read messages" on public.loan_messages;
create policy "portal read messages" on public.loan_messages for select using (
  exists (
    select 1 from public.portal_access pa
    where pa.loan_file_id = loan_messages.loan_file_id
      and pa.portal_user  = auth.uid()
  )
);

-- ── portal_consent ────────────────────────────────────────────────────────────
-- Immutable consent ledger (TCPA / CAN-SPAM / ESIGN / credit-pull auth).
create table if not exists public.portal_consent (
  id            uuid primary key default gen_random_uuid(),
  portal_user   uuid references auth.users(id) on delete set null,
  loan_file_id  uuid references public.loan_files(id) on delete set null,
  consent_type  text not null,              -- 'sms','email','econsent','credit_pull_auth'
  granted       boolean not null,
  ip            text,
  user_agent    text,
  text_shown    text,                       -- exact disclosure text at time of consent
  created_at    timestamptz not null default now()
);
create index if not exists portal_consent_user on public.portal_consent(portal_user, created_at desc);
alter table public.portal_consent enable row level security;
drop policy if exists "own portal_consent" on public.portal_consent;
create policy "own portal_consent" on public.portal_consent
  for select using (auth.uid() = portal_user);

-- ── portal_access_log ─────────────────────────────────────────────────────────
-- Audit: who viewed / downloaded / uploaded / logged in.
create table if not exists public.portal_access_log (
  id            uuid primary key default gen_random_uuid(),
  portal_user   uuid references auth.users(id) on delete set null,
  loan_file_id  uuid references public.loan_files(id) on delete set null,
  action        text not null,              -- 'login','view_file','download_doc','upload_doc'
  target        text,
  ip            text,
  created_at    timestamptz not null default now()
);
create index if not exists portal_access_log_user on public.portal_access_log(portal_user, created_at desc);
create index if not exists portal_access_log_file on public.portal_access_log(loan_file_id, created_at desc);
alter table public.portal_access_log enable row level security;
drop policy if exists "own portal_access_log" on public.portal_access_log;
create policy "own portal_access_log" on public.portal_access_log
  for select using (auth.uid() = portal_user);

-- ── loan_strategy ─────────────────────────────────────────────────────────────
-- WCCI.online output. DRAFT until an LO approves — borrowers can only ever read
-- rows with status='approved' (the RLS gate below enforces the human review step).
create table if not exists public.loan_strategy (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source        text not null default 'wcci',
  payload       jsonb not null,             -- raw WCCI response (server-side only)
  summary       text,                       -- LO-editable borrower-facing summary
  status        text not null default 'draft'
                 check (status in ('draft','approved','hidden')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  approved_at   timestamptz
);
create index if not exists loan_strategy_file on public.loan_strategy(loan_file_id);
alter table public.loan_strategy enable row level security;
drop trigger if exists t_loan_strategy_upd on public.loan_strategy;
create trigger t_loan_strategy_upd before update on public.loan_strategy
  for each row execute function set_updated_at();
-- Borrower/co-borrower may read ONLY approved strategy for their file. Raw payload
-- is never exposed to the portal role by the gateway (it selects `summary` only);
-- this policy is the DB-level backstop for the LO-approval gate.
drop policy if exists "portal read approved strategy" on public.loan_strategy;
create policy "portal read approved strategy" on public.loan_strategy for select using (
  status = 'approved' and exists (
    select 1 from public.portal_access pa
    where pa.loan_file_id = loan_strategy.loan_file_id
      and pa.portal_user  = auth.uid()
      and pa.visibility in ('borrower','coborrower')
  )
);

-- ── Private document bucket ───────────────────────────────────────────────────
-- public = false. NO storage policies for the authenticated role: every read/write
-- goes through the server gateway (service role) after a portal_access check, and
-- downloads are short-lived signed URLs. Financial docs must never be public.
insert into storage.buckets (id, name, public)
values ('ourmtg-docs', 'ourmtg-docs', false)
on conflict (id) do update set public = false;

-- Belt-and-suspenders: ensure no stray public-read policy exists on this bucket.
drop policy if exists "ourmtg-docs public read" on storage.objects;

-- Done. All data-table writes are service-role only; portal users read via the
-- RLS policies above. The projector (sync-loan-file.mjs) keeps loan_files current.
