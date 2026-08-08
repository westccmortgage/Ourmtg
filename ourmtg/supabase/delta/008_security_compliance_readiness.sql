-- OurMTG delta 008 — security/compliance evidence ledger (REVIEW SOURCE ONLY)
--
-- NOT APPLIED. Applying DDL requires an isolated Supabase acceptance run and owner approval.
-- This delta does not declare the product compliant. It creates server-only, append-only places
-- to retain the evidence needed to make and later defend that determination.

do $$
begin
  if to_regclass('public.loan_files') is null
     or to_regclass('public.loan_documents') is null
     or to_regclass('public.mortgage_applications') is null then
    raise exception 'delta 008 requires the portal and conversational-1003 schema';
  end if;
end $$;

create or replace function public.ourmtg_refuse_immutable_change()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create table if not exists public.document_security_assessments (
  id                    uuid primary key default gen_random_uuid(),
  loan_file_id          uuid not null references public.loan_files(id) on delete restrict,
  document_id           uuid not null references public.loan_documents(id) on delete restrict,
  storage_path          text not null,
  detected_content_type text not null,
  byte_count            bigint not null check (byte_count > 0 and byte_count <= 26214400),
  content_sha256        text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  scanner_provider      text not null,
  scan_status           text not null check (scan_status in ('clean','infected','error','unscanned')),
  scanner_reference     text,
  detail_code           text,
  assessed_at           timestamptz not null default now(),
  assessed_by           uuid references auth.users(id) on delete restrict
);
create index if not exists document_security_assessments_document_idx
  on public.document_security_assessments(document_id, assessed_at desc);

create table if not exists public.compliance_catalog_versions (
  catalog_version       text primary key,
  catalog_sha256        text not null check (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  sources               jsonb not null check (jsonb_typeof(sources) = 'array'),
  source_checked_at     date not null,
  review_status         text not null check (review_status in ('draft','approved','retired')),
  reviewed_by           uuid references auth.users(id) on delete restrict,
  reviewed_at           timestamptz,
  review_note           text,
  created_at            timestamptz not null default now(),
  check ((review_status = 'approved') = (reviewed_by is not null and reviewed_at is not null))
);

create table if not exists public.application_compliance_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  loan_file_id          uuid not null references public.loan_files(id) on delete restrict,
  application_id        uuid references public.mortgage_applications(id) on delete restrict,
  catalog_version       text not null references public.compliance_catalog_versions(catalog_version) on delete restrict,
  program               text,
  applicability         jsonb not null check (jsonb_typeof(applicability) = 'object'),
  controls              jsonb not null check (jsonb_typeof(controls) = 'object'),
  blockers              jsonb not null check (jsonb_typeof(blockers) = 'array'),
  status                text not null check (status in ('blocked','ready_for_controlled_pilot')),
  created_by            uuid references auth.users(id) on delete restrict,
  created_at            timestamptz not null default now()
);
create index if not exists application_compliance_snapshots_file_idx
  on public.application_compliance_snapshots(loan_file_id, created_at desc);

create table if not exists public.record_retention_events (
  id                    uuid primary key default gen_random_uuid(),
  loan_file_id          uuid not null references public.loan_files(id) on delete restrict,
  event_type            text not null check (event_type in (
                           'retention_started','hold_applied','hold_released',
                           'disposition_requested','disposition_authorized','disposition_completed'
                         )),
  authority             text not null,
  retain_until          timestamptz,
  reason_code           text not null,
  detail                jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  actor_user_id         uuid references auth.users(id) on delete restrict,
  occurred_at           timestamptz not null default now()
);
create index if not exists record_retention_events_file_idx
  on public.record_retention_events(loan_file_id, occurred_at desc);

do $$
declare
  t text;
begin
  foreach t in array array[
    'document_security_assessments','compliance_catalog_versions',
    'application_compliance_snapshots','record_retention_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all privileges on table public.%I from anon, authenticated', t);
    execute format('drop trigger if exists %I on public.%I', 'immutable_' || t, t);
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.ourmtg_refuse_immutable_change()',
      'immutable_' || t, t
    );
  end loop;
end $$;

-- Verification: four tables, all RLS-on, zero browser grants.
select
  count(*) filter (where c.relrowsecurity) as rls_on,
  count(*) as table_count,
  coalesce(sum((select count(*) from information_schema.role_table_grants g
                where g.table_schema = 'public' and g.table_name = c.relname
                  and g.grantee in ('anon','authenticated'))), 0) as browser_grants
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'document_security_assessments','compliance_catalog_versions',
    'application_compliance_snapshots','record_retention_events'
  );
