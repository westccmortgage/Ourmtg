# OURMTG — Task Pilot Acceptance (Supabase branch)

**Do NOT run against production.** These steps validate `043_ourmtg_operational_pilot.sql` and the
atomic RPCs on a **Supabase branch database**. Adapter-level behavior is already proven by
`npm test`; this is the live-database acceptance.

## 0. Prereqs
- A Supabase **branch** of the shared project (never production).
- Migrations 036–039 already present on the branch.
- Netlify functions pointed at the branch (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE` = branch), with
  `VITE_FF_TASK_PILOT=1` and `VITE_FF_LOAN_TEAM_TASK_PILOT=1` on a **preview** deploy only.

## 1. Apply the migration (branch SQL editor)
Paste `docs/phase1c/migration/043_ourmtg_operational_pilot.sql`. Then:
```sql
select count(*) from information_schema.tables where table_schema='public'
  and table_name in ('organizations','organization_members','loan_events','loan_tasks','loan_task_history'); -- 5
select proname from pg_proc where proname in ('ourmtg_task_create','ourmtg_task_transition'); -- 2
```

## 2. Backfill (branch)
```sql
insert into public.organizations (legal_name, display_name)
  values ('West Coast Capital Mortgage Inc.','West Coast Capital Mortgage') on conflict do nothing;
insert into public.organization_members (organization_id, user_id, role)
  select o.id, lf.owner_user_id, 'loan_officer'
    from public.organizations o
    cross join (select distinct owner_user_id from public.loan_files) lf
   where o.display_name='West Coast Capital Mortgage'
  on conflict (organization_id, user_id) do nothing;
```

## 3. Atomicity & immutability (SQL)
```sql
-- pick an org + loan_file on the branch, then:
select public.ourmtg_task_create(:org, :file, 'document_request', 'Upload pay stubs',
  'Please upload your last 30 days', 'UW: 30d paystubs', 'borrower', null, 'normal', true, null,
  'paystubs_30d', :lo_user, 'loan_officer', :lo_user, 'ourmtg', 'corr-1', 'idem-create-1', now());
-- verify exactly one task + one history(created) + one event(task.created)
select (select count(*) from loan_tasks), (select count(*) from loan_task_history), (select count(*) from loan_events);
-- immutability: expect ERROR
update public.loan_events set event_type='x' where true;      -- must RAISE
delete from public.loan_task_history where true;              -- must RAISE
-- idempotency: repeat create with the SAME idempotency key → no new rows
select public.ourmtg_task_create(:org, :file, 'document_request','x',null,null,'borrower',null,'normal',false,null,null,:lo_user,'loan_officer',:lo_user,'ourmtg','corr-1','idem-create-1', now());
```

## 4. End-to-end (preview app, 2 test accounts)
1. LO account: open a loan file → "Borrower tasks (pilot)" → create a document task.
2. Borrower account (invited to that file): dashboard "Needs your attention" shows the task
   (title, explanation, blocking, action). `internal_requirement` is absent (check network payload).
3. Borrower opens the task → Documents (`?task=<id>`) → uploads → task becomes `submitted`
   (verify `loan_task_history` + `loan_events` each gained one row, atomically).
4. Borrower attempts accept via API → `403` (`forbidden_action`).
5. LO: To review → Accept (or Reject with a borrower-visible reason / More info).
6. Another borrower (different file) requests the task id → `403`. Realtor → `403`.
7. Cross-org: a member of a different org requesting the task → `403` (`Cross-organization access denied`).

## 5. Rollback (branch)
Run the commented `-- ROLLBACK` block from the migration (drops RPCs, tables, guard fn in reverse order).

## Acceptance = all of the above pass on the branch. Do not promote to production or `supabase/migrations/` without owner sign-off.
