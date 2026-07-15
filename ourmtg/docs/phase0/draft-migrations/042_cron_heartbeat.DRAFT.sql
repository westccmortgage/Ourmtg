-- ============================================================================
-- DRAFT — DO NOT APPLY AUTOMATICALLY.  Operational infra, not a domain table.
-- Object: cron_heartbeat (written by _lib/cronGuard.heartbeat, referenced by the
-- deploy runbook's "LO dashboard empty" troubleshooting). NOT created by 036–039.
-- Apply ONLY if the runbook verification shows it is missing (Phase 1A #6). Remove the
-- guard below and paste into the Supabase SQL editor at that point.
-- ============================================================================
DO $$ BEGIN
  RAISE EXCEPTION 'DRAFT — apply only if cron_heartbeat is verified missing (see OURMTG_DEPLOY.md §1).';
END $$;

create table if not exists public.cron_heartbeat (
  name      text primary key,
  last_run  timestamptz not null default now(),
  note      text
);
-- Written by the service role only (heartbeat upsert). No RLS read is required for portal
-- users; enable RLS with no policy => default-deny for the authenticated role.
alter table public.cron_heartbeat enable row level security;

-- -- VERIFY --------------------------------------------------------------------
-- select count(*) from information_schema.tables
--   where table_schema='public' and table_name='cron_heartbeat';   -- expect 1
--
-- -- ROLLBACK ------------------------------------------------------------------
-- drop table if exists public.cron_heartbeat;
