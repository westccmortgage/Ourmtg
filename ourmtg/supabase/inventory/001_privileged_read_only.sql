-- OurMtg privileged production inventory (read-only)
-- Target project: diqukqhbmqcheffhensp
--
-- Run only through a securely injected direct database connection or the Supabase SQL
-- editor. The transaction is explicitly read-only and selects metadata plus aggregate
-- counts only; it does not select borrower/document row contents.

begin transaction read only;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

select
  'connection' as section,
  current_database() as database_name,
  current_user as database_user,
  current_setting('transaction_read_only') as transaction_read_only;

with core(table_name) as (
  values
    ('loan_files'),
    ('portal_users'),
    ('portal_access'),
    ('portal_team'),
    ('portal_invites'),
    ('loan_documents'),
    ('loan_conditions'),
    ('loan_messages'),
    ('portal_consent'),
    ('portal_access_log'),
    ('loan_strategy'),
    ('site_settings'),
    ('cron_heartbeat')
)
select
  'tables_and_rls' as section,
  core.table_name,
  rel.relrowsecurity as rls_enabled,
  rel.relforcerowsecurity as rls_forced
from core
left join (
  select cls.relname, cls.relrowsecurity, cls.relforcerowsecurity
  from pg_catalog.pg_class cls
  join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public'
) rel on rel.relname = core.table_name
order by core.table_name;

select
  'columns' as section,
  table_name,
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'loan_files','portal_users','portal_access','portal_team','portal_invites',
    'loan_documents','loan_conditions','loan_messages','portal_consent',
    'portal_access_log','loan_strategy','site_settings','cron_heartbeat'
  )
order by table_name, ordinal_position;

-- Aggregate counts only. No borrower or document contents are selected.
select 'row_counts' as section, 'loan_files' as object_name, count(*) as row_count from public.loan_files
union all select 'row_counts', 'portal_users', count(*) from public.portal_users
union all select 'row_counts', 'portal_access', count(*) from public.portal_access
union all select 'row_counts', 'portal_team', count(*) from public.portal_team
union all select 'row_counts', 'portal_invites', count(*) from public.portal_invites
union all select 'row_counts', 'loan_documents', count(*) from public.loan_documents
union all select 'row_counts', 'loan_conditions', count(*) from public.loan_conditions
union all select 'row_counts', 'loan_messages', count(*) from public.loan_messages
union all select 'row_counts', 'portal_consent', count(*) from public.portal_consent
union all select 'row_counts', 'portal_access_log', count(*) from public.portal_access_log
union all select 'row_counts', 'loan_strategy', count(*) from public.loan_strategy
union all select 'row_counts', 'site_settings', count(*) from public.site_settings
union all select 'row_counts', 'auth.users', count(*) from auth.users
order by object_name;

select
  'policies' as section,
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_catalog.pg_policies
where (schemaname = 'public' and tablename in (
    'loan_files','portal_users','portal_access','portal_team','portal_invites',
    'loan_documents','loan_conditions','loan_messages','portal_consent',
    'portal_access_log','loan_strategy','site_settings','cron_heartbeat'
  ))
  or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;

select
  'constraints' as section,
  rel.relname as table_name,
  con.conname as constraint_name,
  con.contype as constraint_type,
  pg_catalog.pg_get_constraintdef(con.oid, true) as definition
from pg_catalog.pg_constraint con
join pg_catalog.pg_class rel on rel.oid = con.conrelid
join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
where ns.nspname = 'public'
  and rel.relname in (
    'loan_files','portal_users','portal_access','portal_team','portal_invites',
    'loan_documents','loan_conditions','loan_messages','portal_consent',
    'portal_access_log','loan_strategy','site_settings','cron_heartbeat'
  )
order by rel.relname, con.conname;

select
  'indexes' as section,
  tablename as table_name,
  indexname as index_name,
  indexdef as definition
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in (
    'loan_files','portal_users','portal_access','portal_team','portal_invites',
    'loan_documents','loan_conditions','loan_messages','portal_consent',
    'portal_access_log','loan_strategy','site_settings','cron_heartbeat'
  )
order by tablename, indexname;

select
  'triggers' as section,
  event_object_table as table_name,
  trigger_name,
  action_timing,
  event_manipulation,
  action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in (
    'loan_files','portal_users','portal_access','portal_team','portal_invites',
    'loan_documents','loan_conditions','loan_messages','portal_consent',
    'portal_access_log','loan_strategy','site_settings','cron_heartbeat'
  )
order by event_object_table, trigger_name, event_manipulation;

select
  'storage_bucket' as section,
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
from storage.buckets
where id = 'ourmtg-docs';

select
  'table_privileges' as section,
  grantee,
  table_schema,
  table_name,
  privilege_type
from information_schema.role_table_grants
where grantee in ('anon','authenticated','service_role')
  and (
    (table_schema = 'public' and table_name in (
      'loan_files','portal_users','portal_access','portal_team','portal_invites',
      'loan_documents','loan_conditions','loan_messages','portal_consent',
      'portal_access_log','loan_strategy','site_settings','cron_heartbeat'
    ))
    or (table_schema = 'storage' and table_name in ('buckets','objects'))
  )
order by grantee, table_schema, table_name, privilege_type;

commit;
