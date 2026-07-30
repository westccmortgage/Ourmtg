-- OurMTG — apply Conversational 1003 to the LIVE project, in one paste.
--
-- GENERATED FILE. The transactional body below is copied verbatim from
-- supabase/delta/003_conversational_1003.sql; tests/applyScriptSync.test.mjs fails the build
-- if the two ever drift. Edit the delta, never this file.
--
-- WHY IT EXISTS: applying the delta and then interpreting a JSON verification blob is two
-- steps and a judgement call. This is one step and one sentence of output. Same SQL, same
-- guard, same transaction — only the reporting differs.
--
-- Target project: diqukqhbmqcheffhensp (the live project named in docs/OURMTG-CLEAN-FOUNDATION.md).
-- Running it anywhere else aborts on the guard below without creating anything.
--
-- Safe to run twice: every object uses "if not exists", and nothing here alters, drops, or
-- writes to a table that already exists.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Refuse to run against a database that is not this product.
do $$
begin
  if to_regclass('public.loan_files') is null
     or to_regclass('public.portal_access') is null then
    raise exception 'Wrong or incomplete project: OurMTG core is missing';
  end if;
end;
$$;

-- ── One application per loan file + version ──────────────────────────────────
create table if not exists public.mortgage_applications (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid,
  loan_file_id        uuid not null references public.loan_files(id) on delete cascade,
  application_version integer not null default 1,
  status              text not null default 'not_started'
                      check (status in ('not_started','in_progress','waiting_on_borrower',
                                        'needs_clarification','ready_for_borrower_review',
                                        'borrower_attested','ready_for_team_review',
                                        'returned_for_clarification','accepted_into_loan_file')),
  schema_version      text not null,
  catalog_version     text not null,
  rules_version       text not null,
  locale              text not null default 'en' check (locale in ('en','es','ru','zh-Hans')),
  percent_complete    integer not null default 0 check (percent_complete between 0 and 100),
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (loan_file_id, application_version)
);
create index if not exists mortgage_applications_loan_idx on public.mortgage_applications(loan_file_id);
alter table public.mortgage_applications enable row level security;
revoke all privileges on table public.mortgage_applications from anon, authenticated;

-- ── Parties (borrower / co-borrower) — separate interview state each ─────────
create table if not exists public.application_parties (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.mortgage_applications(id) on delete cascade,
  organization_id uuid,
  loan_file_id    uuid not null references public.loan_files(id) on delete cascade,
  party_index     integer not null check (party_index >= 0),
  party_role      text not null check (party_role in ('borrower','coborrower')),
  portal_user     uuid references auth.users(id) on delete set null,
  display_name    text,
  locale          text check (locale is null or locale in ('en','es','ru','zh-Hans')),
  -- Per-party question history: attempts, confusion counts, temporary skips.
  asked_history   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (application_id, party_index)
);
create index if not exists application_parties_user_idx on public.application_parties(portal_user);
alter table public.application_parties enable row level security;
revoke all privileges on table public.application_parties from anon, authenticated;

-- ── Immutable field history ──────────────────────────────────────────────────
-- Never updated, never deleted. A correction appends a new row and marks the prior one
-- superseded via superseded_by; the borrower's original wording is preserved alongside.
create table if not exists public.application_field_events (
  id                  uuid primary key default gen_random_uuid(),
  application_id      uuid not null references public.mortgage_applications(id) on delete cascade,
  party_id            uuid references public.application_parties(id) on delete cascade,
  organization_id     uuid,
  loan_file_id        uuid not null references public.loan_files(id) on delete cascade,
  field_path          text not null,
  template_path       text not null,
  section             text,
  normalized_value    jsonb,
  display_value       text,
  status              text not null
                      check (status in ('missing','candidate','needs_clarification',
                                        'borrower_confirmed','team_confirmed','not_applicable',
                                        'declined_allowed','conflicting','superseded')),
  source              text not null
                      check (source in ('borrower_text','borrower_voice_transcript',
                                        'borrower_secure_input','team_entry','imported_credit',
                                        'imported_los','document_extraction','system_derived')),
  source_turn_id      uuid,
  original_text       text,
  confidence          numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  estimated           boolean not null default false,
  is_correction       boolean not null default false,
  clarification_reason text,
  previous_event_id   uuid references public.application_field_events(id) on delete set null,
  superseded_by       uuid references public.application_field_events(id) on delete set null,
  application_version text not null,
  catalog_version     text not null,
  prompt_version      text,
  provider_name       text,
  provider_model      text,
  actor_user_id       uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists application_field_events_app_idx  on public.application_field_events(application_id, field_path);
create index if not exists application_field_events_turn_idx on public.application_field_events(source_turn_id);
alter table public.application_field_events enable row level security;
revoke all privileges on table public.application_field_events from anon, authenticated;

-- ── Current projection (derived; rebuildable from the event log) ─────────────
create table if not exists public.application_field_state (
  id               uuid primary key default gen_random_uuid(),
  application_id   uuid not null references public.mortgage_applications(id) on delete cascade,
  party_id         uuid references public.application_parties(id) on delete cascade,
  organization_id  uuid,
  loan_file_id     uuid not null references public.loan_files(id) on delete cascade,
  field_path       text not null,
  section          text,
  normalized_value jsonb,
  display_value    text,
  status           text not null,
  source           text not null,
  estimated        boolean not null default false,
  confidence       numeric,
  event_id         uuid references public.application_field_events(id) on delete set null,
  -- Both sides of an unresolved contradiction, so the planner can offer the borrower a choice.
  conflict_values  jsonb,
  confirmed_at     timestamptz,
  confirmed_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (application_id, field_path)
);
create index if not exists application_field_state_status_idx on public.application_field_state(application_id, status);
alter table public.application_field_state enable row level security;
revoke all privileges on table public.application_field_state from anon, authenticated;

-- ── Conversation turns (idempotency + failure recovery, §24) ─────────────────
-- The borrower's turn is persisted BEFORE interpretation is attempted, which is what makes
-- "your answer is never lost because the model timed out" a property of the schema and not
-- just of the code.
create table if not exists public.application_turns (
  id                uuid primary key default gen_random_uuid(),
  application_id    uuid not null references public.mortgage_applications(id) on delete cascade,
  party_id          uuid references public.application_parties(id) on delete cascade,
  organization_id   uuid,
  loan_file_id      uuid not null references public.loan_files(id) on delete cascade,
  idempotency_key   text not null,
  request_hash      text not null,
  processing_state  text not null default 'received'
                    check (processing_state in ('received','processing','interpreted','needs_retry','failed_safe')),
  direction         text not null default 'in' check (direction in ('in','out')),
  input_mode        text not null default 'text' check (input_mode in ('text','voice','structured','control')),
  borrower_text     text,
  locale            text,
  asked_question_id text,
  asked_field_path  text,
  intent            text,
  answer_relevance  text check (answer_relevance is null or answer_relevance in ('direct','partial','unrelated','unclear')),
  misunderstanding  text,
  safety_flags      text[] not null default '{}',
  provider_name     text,
  provider_model    text,
  prompt_version    text,
  attempts          integer not null default 0,
  error_code        text,
  created_at        timestamptz not null default now(),
  interpreted_at    timestamptz,
  unique (application_id, idempotency_key)
);
create index if not exists application_turns_app_idx on public.application_turns(application_id, created_at);
alter table public.application_turns enable row level security;
revoke all privileges on table public.application_turns from anon, authenticated;

-- ── Sensitive values — masked storage only (§15) ─────────────────────────────
-- The plaintext SSN / account number is NOT stored by this migration. `last_four` is what the
-- product displays back; `value_digest` is a keyed hash for duplicate detection only. Wiring
-- an encrypted column requires a KMS decision the owner has not made — see the deployment doc.
create table if not exists public.application_secure_fields (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.mortgage_applications(id) on delete cascade,
  party_id        uuid not null references public.application_parties(id) on delete cascade,
  organization_id uuid,
  loan_file_id    uuid not null references public.loan_files(id) on delete cascade,
  field_path      text not null,
  last_four       text check (last_four is null or last_four ~ '^[0-9]{4}$'),
  value_digest    text not null,
  captured_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (application_id, field_path, party_id)
);
alter table public.application_secure_fields enable row level security;
revoke all privileges on table public.application_secure_fields from anon, authenticated;

-- ── Borrower attestation ─────────────────────────────────────────────────────
-- A conversational "yes" is NOT an electronic signature (§6.J). This records that the
-- borrower reviewed and attested to the information; e-sign remains a separate workflow.
create table if not exists public.application_attestations (
  id                 uuid primary key default gen_random_uuid(),
  application_id     uuid not null references public.mortgage_applications(id) on delete cascade,
  party_id           uuid not null references public.application_parties(id) on delete cascade,
  organization_id    uuid,
  loan_file_id       uuid not null references public.loan_files(id) on delete cascade,
  document_key       text not null,
  document_version   text not null,
  presented_at       timestamptz not null,
  accepted_at        timestamptz not null,
  accepted_by        uuid references auth.users(id) on delete set null,
  application_snapshot jsonb not null,
  completeness_snapshot jsonb not null,
  ip                 inet,
  user_agent         text,
  created_at         timestamptz not null default now()
);
create index if not exists application_attestations_app_idx on public.application_attestations(application_id);
alter table public.application_attestations enable row level security;
revoke all privileges on table public.application_attestations from anon, authenticated;

commit;

-- ── Result, in one line ─────────────────────────────────────────────────────
select case
         when t.tables_found = 7 and t.rls_on_all and t.browser_grants = 0
           then 'PASS - 7 tables created, RLS on all of them, browser has no access'
         else 'FAIL - tables_found=' || t.tables_found
              || ', rls_on_all=' || coalesce(t.rls_on_all::text, 'null')
              || ', browser_grants=' || t.browser_grants
              || ' (expected 7 / true / 0)'
       end as result
from (
  select
    (select count(*) from information_schema.tables
      where table_schema = 'public' and table_name in (
        'mortgage_applications','application_parties','application_field_events',
        'application_field_state','application_turns','application_secure_fields',
        'application_attestations')) as tables_found,
    (select bool_and(relrowsecurity) from pg_catalog.pg_class
      where oid in ('public.mortgage_applications'::regclass,
                    'public.application_parties'::regclass,
                    'public.application_field_events'::regclass,
                    'public.application_field_state'::regclass,
                    'public.application_turns'::regclass,
                    'public.application_secure_fields'::regclass,
                    'public.application_attestations'::regclass)) as rls_on_all,
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon','authenticated')
        and table_name in (
          'mortgage_applications','application_parties','application_field_events',
          'application_field_state','application_turns','application_secure_fields',
          'application_attestations')) as browser_grants
) t;
