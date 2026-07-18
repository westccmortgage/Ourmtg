-- OurMtg minimal live-core hardening delta
-- REVIEWED SOURCE ONLY — UNAPPLIED
-- Target Supabase project: diqukqhbmqcheffhensp
--
-- Derived from the privileged read-only inventory generated at
-- 2026-07-18T05:32:04.516707Z. This delta does not create workflow tables, touch borrower
-- row contents, activate migration 043, or add the optional cron heartbeat.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Fail closed if this is accidentally pasted into the wrong Supabase project.
do $$
declare
  required_table text;
begin
  foreach required_table in array array[
    'loan_files','portal_users','portal_access','portal_team','portal_invites',
    'loan_documents','loan_conditions','loan_messages','portal_consent',
    'portal_access_log','loan_strategy','site_settings'
  ]
  loop
    if to_regclass('public.' || required_table) is null then
      raise exception 'Wrong or incomplete project: public.% is missing', required_table;
    end if;
  end loop;

  if not exists (select 1 from storage.buckets where id = 'ourmtg-docs') then
    raise exception 'Wrong or incomplete project: private ourmtg-docs bucket is missing';
  end if;

  if exists (
    select 1
    from public.loan_files
    where amount < 0 or preapproval_amount < 0
  ) then
    raise exception 'Integrity preflight failed: a loan amount is negative';
  end if;
end;
$$;

-- Raw WCCI payloads are server-only. The old SELECT policy exposed every column in an
-- approved strategy row, while RLS cannot hide only the payload column.
drop policy if exists "portal read approved strategy" on public.loan_strategy;
revoke all privileges on table public.loan_strategy from anon, authenticated;

-- Preserve the server validation at the database boundary as well.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.loan_files'::regclass
      and conname = 'loan_files_amount_check'
  ) then
    execute 'alter table public.loan_files add constraint loan_files_amount_check check (amount is null or amount >= 0)';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.loan_files'::regclass
      and conname = 'loan_files_preapproval_amount_check'
  ) then
    execute 'alter table public.loan_files add constraint loan_files_preapproval_amount_check check (preapproval_amount is null or preapproval_amount >= 0)';
  end if;
end;
$$;

-- Match the existing 25 MB client cap at the Storage boundary and enforce the same MIME
-- allowlist against the uploaded object, not only the browser-declared request metadata.
update storage.buckets
set
  public = false,
  file_size_limit = 26214400,
  allowed_mime_types = array[
    'application/pdf','image/jpeg','image/png','image/heic','image/heif'
  ]::text[]
where id = 'ourmtg-docs';

commit;

-- Non-sensitive post-apply verification. This selects metadata only.
select jsonb_build_object(
  'strategy_browser_policy_present', exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'loan_strategy'
      and policyname = 'portal read approved strategy'
  ),
  'strategy_browser_privileges', coalesce((
    select jsonb_agg(jsonb_build_object('role', grantee, 'privilege', privilege_type))
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'loan_strategy'
      and grantee in ('anon','authenticated')
  ), '[]'::jsonb),
  'amount_checks', coalesce((
    select jsonb_agg(conname order by conname)
    from pg_catalog.pg_constraint
    where conrelid = 'public.loan_files'::regclass
      and conname in ('loan_files_amount_check','loan_files_preapproval_amount_check')
  ), '[]'::jsonb),
  'storage_bucket', (
    select jsonb_build_object(
      'id', id,
      'public', public,
      'file_size_limit', file_size_limit,
      'allowed_mime_types', allowed_mime_types
    )
    from storage.buckets
    where id = 'ourmtg-docs'
  )
) as verification;
