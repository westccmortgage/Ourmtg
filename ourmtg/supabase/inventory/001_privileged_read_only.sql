-- OurMtg privileged production inventory (read-only)
-- Target project: diqukqhbmqcheffhensp
--
-- Run only through a securely injected direct database connection or the Supabase SQL
-- editor. The transaction is explicitly read-only and selects metadata plus aggregate
-- counts only; it does not select borrower/document row contents.
--
-- The final statement returns exactly ONE ROW with one JSON value. This is intentional:
-- Supabase SQL Editor exports only the final result set, so every inventory section must
-- be contained in that single result.

begin transaction read only;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

with
core(table_name) as (
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
),
experimental(table_name) as (
  values
    ('organizations'),
    ('organization_members'),
    ('loan_tasks'),
    ('loan_task_history'),
    ('loan_events'),
    ('cash_to_close_items'),
    ('cash_to_close_snapshots'),
    ('loan_cash_to_close'),
    ('loan_milestones'),
    ('loan_vendor_orders'),
    ('notification_deliveries'),
    ('disclosure_packages'),
    ('third_party_items')
),
public_relations as (
  select
    cls.oid,
    cls.relname,
    cls.relrowsecurity,
    cls.relforcerowsecurity
  from pg_catalog.pg_class cls
  join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public'
),
table_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table', core.table_name,
        'exists', rel.oid is not null,
        'rls_enabled', rel.relrowsecurity,
        'rls_forced', rel.relforcerowsecurity
      ) order by core.table_name
    ),
    '[]'::jsonb
  ) as data
  from core
  left join public_relations rel on rel.relname = core.table_name
),
experimental_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table', experimental.table_name,
        'exists', rel.oid is not null
      ) order by experimental.table_name
    ),
    '[]'::jsonb
  ) as data
  from experimental
  left join public_relations rel on rel.relname = experimental.table_name
),
column_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table', table_name,
        'position', ordinal_position,
        'column', column_name,
        'type', data_type,
        'nullable', is_nullable,
        'default', column_default
      ) order by table_name, ordinal_position
    ),
    '[]'::jsonb
  ) as data
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (select core.table_name from core)
),
row_count_inventory as (
  select jsonb_build_object(
    'loan_files', (select count(*) from public.loan_files),
    'portal_users', (select count(*) from public.portal_users),
    'portal_access', (select count(*) from public.portal_access),
    'portal_team', (select count(*) from public.portal_team),
    'portal_invites', (select count(*) from public.portal_invites),
    'loan_documents', (select count(*) from public.loan_documents),
    'loan_conditions', (select count(*) from public.loan_conditions),
    'loan_messages', (select count(*) from public.loan_messages),
    'portal_consent', (select count(*) from public.portal_consent),
    'portal_access_log', (select count(*) from public.portal_access_log),
    'loan_strategy', (select count(*) from public.loan_strategy),
    'site_settings', (select count(*) from public.site_settings),
    'auth.users', (select count(*) from auth.users)
  ) as data
),
policy_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'schema', schemaname,
        'table', tablename,
        'policy', policyname,
        'permissive', permissive,
        'roles', roles,
        'command', cmd,
        'using', qual,
        'with_check', with_check
      ) order by schemaname, tablename, policyname
    ),
    '[]'::jsonb
  ) as data
  from pg_catalog.pg_policies
  where (schemaname = 'public' and tablename in (select core.table_name from core))
     or (schemaname = 'storage' and tablename = 'objects')
),
constraint_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table', rel.relname,
        'constraint', con.conname,
        'type', con.contype,
        'definition', pg_catalog.pg_get_constraintdef(con.oid, true)
      ) order by rel.relname, con.conname
    ),
    '[]'::jsonb
  ) as data
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class rel on rel.oid = con.conrelid
  join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
  where ns.nspname = 'public'
    and rel.relname in (select core.table_name from core)
),
index_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table', tablename,
        'index', indexname,
        'definition', indexdef
      ) order by tablename, indexname
    ),
    '[]'::jsonb
  ) as data
  from pg_catalog.pg_indexes
  where schemaname = 'public'
    and tablename in (select core.table_name from core)
),
trigger_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'table', event_object_table,
        'trigger', trigger_name,
        'timing', action_timing,
        'event', event_manipulation,
        'statement', action_statement
      ) order by event_object_table, trigger_name, event_manipulation
    ),
    '[]'::jsonb
  ) as data
  from information_schema.triggers
  where event_object_schema = 'public'
    and event_object_table in (select core.table_name from core)
),
storage_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'name', name,
        'public', public,
        'file_size_limit', file_size_limit,
        'allowed_mime_types', allowed_mime_types
      ) order by id
    ),
    '[]'::jsonb
  ) as data
  from storage.buckets
  where id = 'ourmtg-docs'
),
privilege_groups as (
  select
    grantee,
    table_schema,
    table_name,
    array_agg(privilege_type order by privilege_type) as privileges
  from information_schema.role_table_grants
  where grantee in ('anon','authenticated','service_role')
    and (
      (table_schema = 'public' and table_name in (select core.table_name from core))
      or (table_schema = 'storage' and table_name in ('buckets','objects'))
    )
  group by grantee, table_schema, table_name
),
privilege_inventory as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role', grantee,
        'schema', table_schema,
        'table', table_name,
        'privileges', privileges
      ) order by grantee, table_schema, table_name
    ),
    '[]'::jsonb
  ) as data
  from privilege_groups
)
select jsonb_build_object(
  'generated_at', clock_timestamp(),
  'connection', jsonb_build_object(
    'database', current_database(),
    'user', current_user,
    'transaction_read_only', current_setting('transaction_read_only')
  ),
  'tables_and_rls', table_inventory.data,
  'experimental_tables', experimental_inventory.data,
  'columns', column_inventory.data,
  'row_counts', row_count_inventory.data,
  'policies', policy_inventory.data,
  'constraints', constraint_inventory.data,
  'indexes', index_inventory.data,
  'triggers', trigger_inventory.data,
  'storage_buckets', storage_inventory.data,
  'table_privileges', privilege_inventory.data
) as inventory
from table_inventory
cross join experimental_inventory
cross join column_inventory
cross join row_count_inventory
cross join policy_inventory
cross join constraint_inventory
cross join index_inventory
cross join trigger_inventory
cross join storage_inventory
cross join privilege_inventory;

commit;
