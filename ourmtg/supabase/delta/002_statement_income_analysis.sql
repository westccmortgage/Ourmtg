-- OurMtg human-reviewed Statement Income Analysis
-- REVIEWED SOURCE ONLY — UNAPPLIED
-- Target Supabase project: diqukqhbmqcheffhensp
--
-- Adds server-only analysis records and extracted monthly statement summaries. It does
-- not expose statement data to browser roles and does not issue a pre-approval.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.loan_files') is null
     or to_regclass('public.loan_documents') is null
     or not exists (select 1 from storage.buckets where id = 'ourmtg-docs') then
    raise exception 'Wrong or incomplete project: OurMtg core is missing';
  end if;
end;
$$;

create table if not exists public.statement_income_analyses (
  id                          uuid primary key default gen_random_uuid(),
  loan_file_id                uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id               uuid not null references auth.users(id) on delete cascade,
  status                      text not null default 'needs_review'
                              check (status in ('needs_review','reviewed','superseded')),
  statement_type              text not null check (statement_type in ('personal','business')),
  period_months               integer not null check (period_months in (12,24)),
  expense_factor_pct          numeric not null default 50 check (expense_factor_pct between 0 and 100),
  ownership_pct               numeric not null default 100 check (ownership_pct between 0 and 100),
  calculated_monthly_income   numeric check (calculated_monthly_income is null or calculated_monthly_income >= 0),
  reviewed_monthly_income     numeric check (reviewed_monthly_income is null or reviewed_monthly_income >= 0),
  calculation                 jsonb not null default '{}'::jsonb,
  reviewer_notes              text,
  borrower_visible            boolean not null default false,
  created_by                  uuid references auth.users(id) on delete set null,
  reviewed_by                 uuid references auth.users(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  reviewed_at                 timestamptz
);
create index if not exists statement_income_file
  on public.statement_income_analyses (loan_file_id, created_at desc);
alter table public.statement_income_analyses enable row level security;
drop trigger if exists t_statement_income_analyses_upd on public.statement_income_analyses;
create trigger t_statement_income_analyses_upd
  before update on public.statement_income_analyses
  for each row execute function public.set_updated_at();
revoke all privileges on table public.statement_income_analyses from anon, authenticated;

create table if not exists public.statement_income_months (
  id                    uuid primary key default gen_random_uuid(),
  analysis_id           uuid not null references public.statement_income_analyses(id) on delete cascade,
  loan_file_id          uuid not null references public.loan_files(id) on delete cascade,
  source_document_id    uuid references public.loan_documents(id) on delete set null,
  account_label         text,
  statement_month       date,
  total_deposits        numeric check (total_deposits is null or total_deposits >= 0),
  excluded_deposits     numeric not null default 0 check (excluded_deposits >= 0),
  extraction_status     text not null default 'needs_manual_entry'
                        check (extraction_status in ('extracted','manual','needs_manual_entry','unreadable')),
  needs_review          boolean not null default true,
  reviewer_note         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists statement_income_months_analysis
  on public.statement_income_months (analysis_id, statement_month);
alter table public.statement_income_months enable row level security;
drop trigger if exists t_statement_income_months_upd on public.statement_income_months;
create trigger t_statement_income_months_upd
  before update on public.statement_income_months
  for each row execute function public.set_updated_at();
revoke all privileges on table public.statement_income_months from anon, authenticated;

commit;

select jsonb_build_object(
  'tables', jsonb_build_array(
    to_regclass('public.statement_income_analyses')::text,
    to_regclass('public.statement_income_months')::text
  ),
  'browser_privileges', coalesce((
    select jsonb_agg(jsonb_build_object(
      'table', table_name,
      'role', grantee,
      'privilege', privilege_type
    ))
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('statement_income_analyses','statement_income_months')
      and grantee in ('anon','authenticated')
  ), '[]'::jsonb),
  'rls_enabled', (
    select bool_and(relrowsecurity)
    from pg_catalog.pg_class
    where oid in (
      'public.statement_income_analyses'::regclass,
      'public.statement_income_months'::regclass
    )
  )
) as verification;
