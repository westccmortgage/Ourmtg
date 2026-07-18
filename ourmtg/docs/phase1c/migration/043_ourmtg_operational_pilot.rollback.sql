-- ============================================================================================
-- OURMTG PHASE 1C — MIGRATION 043 ROLLBACK (REVIEW SOURCE ONLY — MUST NOT BE EXECUTED)
-- ============================================================================================
-- (1) SAFETY GUARD & ENVIRONMENT WARNING
-- This file is the reviewed, dependency-ordered rollback companion to
-- 043_ourmtg_operational_pilot.sql. It is REVIEW SOURCE ONLY. Migration 043 has NOT been applied,
-- so NO rollback is currently required. Do NOT run this file. The destructive DROP/ALTER statements
-- below are intentionally kept COMMENTED so that accidentally executing the file performs nothing
-- destructive; and this leading guard raises immediately if the file is fed to a database as-is.
--
-- Running this rollback removes operational tables that hold IMMUTABLE audit evidence
-- (loan_events, loan_task_history). That is acceptable ONLY on a disposable isolated Supabase
-- branch. It is NOT the production decommission procedure (see section 9).
do $$
begin
  raise exception 'refuse_to_run: 043 rollback is review source only. Migration 043 is unapplied; there is nothing to roll back. Remove this guard and uncomment blocks deliberately, on an approved isolated branch only.';
end $$;

-- ============================================================================================
-- (2) CONFIRM PILOT FLAGS ARE DISABLED (operator checklist — outside the database)
-- Before any rollback on a branch environment, confirm the server flags are OFF so no traffic is
-- mutating the pilot tables mid-rollback:
--     FF_TASK_PILOT            unset / not 'true'|'1'
--     FF_LOAN_TEAM_TASK_PILOT  unset / not 'true'|'1'
--   (and the client VITE_FF_* presentation flags OFF). These are environment variables, not database
--   state; verify them in the deploy/runtime configuration, not here.

-- ============================================================================================
-- (3) PRE-ROLLBACK INVENTORY COUNTS (safe SELECTs — run first, capture output)
-- select 'organizations' t, count(*) c from public.organizations
-- union all select 'organization_members', count(*) from public.organization_members
-- union all select 'loan_events', count(*) from public.loan_events
-- union all select 'loan_tasks', count(*) from public.loan_tasks
-- union all select 'loan_task_history', count(*) from public.loan_task_history
-- union all select 'loan_files_with_org', count(*) from public.loan_files where organization_id is not null;

-- ============================================================================================
-- (4) EXPORT / SNAPSHOT INSTRUCTIONS (perform BEFORE any destructive step)
-- Export each of the following to durable storage (CSV or a retained schema) and record checksums:
--     loan_events            -- immutable domain-event audit
--     loan_task_history      -- immutable task-history audit
--     loan_tasks             -- operational task state
--     organization_members   -- membership assignments
--     organizations          -- org registry
--     affected loan_files    -- specifically the (id, organization_id, owner_user_id) triples changed by 043
-- Example (branch):
--   \copy (select * from public.loan_events)         to 'rollback_loan_events.csv' csv header
--   \copy (select * from public.loan_task_history)   to 'rollback_loan_task_history.csv' csv header
--   \copy (select * from public.loan_tasks)          to 'rollback_loan_tasks.csv' csv header
--   \copy (select * from public.organization_members) to 'rollback_org_members.csv' csv header
--   \copy (select * from public.organizations)       to 'rollback_organizations.csv' csv header
--   \copy (select id, organization_id, owner_user_id from public.loan_files) to 'rollback_loan_files_org.csv' csv header

-- ============================================================================================
-- (5) EXPLICIT DECISION GATE BEFORE DELETING IMMUTABLE AUDIT EVIDENCE
-- Dropping loan_events / loan_task_history DESTROYS append-only audit rows. DROP TABLE bypasses the
-- row-level immutability trigger and the ON DELETE RESTRICT foreign keys that otherwise protect this
-- evidence. Proceed only after a named approver has confirmed, in writing, that:
--     (a) the environment is a DISPOSABLE isolated branch (not production), AND
--     (b) the section (4) exports have completed and been verified.
-- If either is not true, STOP. See section (9)/(10) for production.

-- ============================================================================================
-- (6) REVERSE DEPENDENCY-ORDER ROLLBACK (uncomment deliberately, in this order)
-- ---- 6a. Operational RPCs (no structural dependents) ----
-- drop function if exists public.ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz);
-- drop function if exists public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,text,text,text,text,timestamptz);
-- drop function if exists public.ourmtg_task_create(uuid,uuid,text,text,text,text,uuid,boolean,text,boolean,timestamptz,uuid,text,uuid,text,uuid,text,text,text,text,timestamptz);
-- ---- 6b. Canonical helper functions ----
-- drop function if exists public.ourmtg_task_role_allows(text,text);
-- drop function if exists public.ourmtg_task_event_type(text);
-- drop function if exists public.ourmtg_task_next_status(text,text);
-- ---- 6c. Task history (references loan_tasks; drop before tasks) ----
-- drop table if exists public.loan_task_history;
-- ---- 6d. Tasks (references organizations, loan_files, loan_events, loan_documents, loan_conditions) ----
-- drop table if exists public.loan_tasks;
-- ---- 6e. Events (references organizations, loan_files) ----
-- drop table if exists public.loan_events;
-- ---- 6f. Organization memberships ----
-- drop table if exists public.organization_members;
-- ---- 6g. loan_files.organization_id — drop the NOT NULL/FK/index/column (additive column added by 043) ----
-- alter table public.loan_files alter column organization_id drop not null;
-- drop index if exists public.loan_files_org;
-- alter table public.loan_files drop column if exists organization_id;   -- drops the FK to organizations with the column
-- ---- 6h. Organizations (now unreferenced) ----
-- drop table if exists public.organizations;
-- ---- 6i. Immutable trigger function (its triggers were removed with 6c/6e tables) ----
-- drop function if exists public.ourmtg_raise_immutable();
--   NOTE: do NOT drop set_updated_at() or the pgcrypto extension — both pre-date 043 and are shared.

-- ============================================================================================
-- (7) ON DELETE RESTRICT HANDLING
-- The rollback DROPS tables in reverse dependency order (7c→7h above); it does NOT DELETE rows, so
-- the ON DELETE RESTRICT foreign keys are never triggered. Dropping the referencing table (history
-- before tasks; tasks/events before organizations; loan_files.organization_id column before
-- organizations) removes each constraint before its target. Do NOT use DROP TABLE ... CASCADE as a
-- shortcut — CASCADE could silently remove unexpected dependents; keep the explicit order instead.

-- ============================================================================================
-- (8) POST-ROLLBACK VALIDATION QUERIES (expect the 043 objects to be gone)
-- select count(*) from information_schema.tables where table_schema='public'
--   and table_name in ('organizations','organization_members','loan_events','loan_tasks','loan_task_history'); -- expect 0
-- select count(*) from pg_proc where proname in
--   ('ourmtg_task_create','ourmtg_task_transition','ourmtg_document_finalize_submit',
--    'ourmtg_task_next_status','ourmtg_task_event_type','ourmtg_task_role_allows','ourmtg_raise_immutable'); -- expect 0
-- select count(*) from information_schema.columns
--   where table_schema='public' and table_name='loan_files' and column_name='organization_id'; -- expect 0

-- ============================================================================================
-- (9) DISPOSABLE ISOLATED-BRANCH ROLLBACK vs PRODUCTION RETENTION/DECOMMISSION
-- Disposable isolated branch: after exports (4) and the decision gate (5), sections (6) may be run to
--   return the branch to its pre-043 shape. The branch itself is typically discarded afterward.
-- Production retention/decommission: this file is NOT a production procedure. A production
--   decommission must (a) disable flags and drain in-flight operations, (b) export and RETAIN all
--   loan_events / loan_task_history to the system of record under the applicable retention policy,
--   (c) prefer soft archival (organizations.archived_at / loan_tasks.archived_at) over destructive
--   drops, and (d) obtain compliance/records sign-off before removing any audit object.

-- ============================================================================================
-- (10) WARNING — PRODUCTION AUDIT DATA MUST NOT BE SILENTLY DELETED
-- loan_events and loan_task_history are immutable operational evidence. Never hard-delete them in a
-- production or shared environment merely to simplify a rollback. If retention is required, export
-- and retain first, prefer soft archive, and delete only under an explicit, approved records policy.
-- ============================================================================================
