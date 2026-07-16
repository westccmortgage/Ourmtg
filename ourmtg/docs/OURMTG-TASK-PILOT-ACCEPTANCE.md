# OURMTG — Task Pilot Acceptance (Supabase branch)

**Do NOT run against production.** These steps validate `043_ourmtg_operational_pilot.sql` **Rev 2**
(external-review hardening, EXT-1..EXT-13) and its atomic, `service_role`-only RPCs on a **Supabase
branch database**. Adapter-level behavior is already proven by `npm test` (fake-adapter tests, NOT a
live database); this file is the **live-database** acceptance that has **not been run** — no isolated
branch has been provided.

## 0. Prereqs
- A Supabase **branch** of the shared project (never production).
- Migrations 036–039 already present on the branch.
- Netlify functions pointed at the branch (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` = branch).
- **Server** flags on a **preview** deploy only: `FF_TASK_PILOT=1`, `FF_LOAN_TEAM_TASK_PILOT=1`
  (EXT-10 — these authorize the backend; `VITE_FF_*` is presentation-only and authorizes nothing).

## 1. Apply the migration (branch SQL editor)
Paste `docs/phase1c/migration/043_ourmtg_operational_pilot.sql`. Then:
```sql
select count(*) from information_schema.tables where table_schema='public'
  and table_name in ('organizations','organization_members','loan_events','loan_tasks','loan_task_history'); -- 5
select proname from pg_proc
  where proname in ('ourmtg_task_create','ourmtg_task_transition','ourmtg_document_finalize_submit'); -- 3
```

## 2. Deterministic org backfill — EXT-13 (branch)
Slug `west-coast-capital-mortgage` is the stable unique key. Backfill is **not** auto-run; execute the
commented EXT-13 block from the migration in order (preflight → upsert on `slug` → membership →
`loan_files.organization_id` → null/mismatch report). Acceptance:
```sql
-- preflight must PASS (no WCC display_name under a different slug):
-- (the DO block raises if a conflicting slug exists — must not raise)
select count(*) as files_without_org from public.loan_files where organization_id is null;        -- expect 0
select count(*) as owners_without_membership from (
  select distinct lf.owner_user_id from public.loan_files lf
  left join public.organization_members m on m.user_id = lf.owner_user_id
  where m.user_id is null) t;                                                                       -- expect 0
select count(*) from public.organizations where slug='west-coast-capital-mortgage';                -- expect 1
```

## 3. EXT-2 — base tables are NOT borrower-selectable
The borrower reads ONLY through the authenticated gateway; `authenticated`/`anon` have no direct SELECT.
```sql
select has_table_privilege('authenticated','public.loan_tasks','SELECT');        -- expect false
select has_table_privilege('authenticated','public.loan_events','SELECT');       -- expect false
select has_table_privilege('authenticated','public.loan_task_history','SELECT'); -- expect false
select has_table_privilege('anon','public.loan_tasks','SELECT');                 -- expect false
-- organization_members is SELECT-only for the row's own user (org resolution):
select has_table_privilege('authenticated','public.organization_members','SELECT'); -- expect true (RLS: own rows)
```

## 4. EXT-3 — SECURITY DEFINER RPCs are service_role-only
```sql
select has_function_privilege('authenticated',
  'public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,uuid,text,text,text,text,timestamptz)','EXECUTE'); -- false
select has_function_privilege('anon',
  'public.ourmtg_task_create(uuid,uuid,text,text,text,text,text,uuid,boolean,text,boolean,timestamptz,text,uuid,text,uuid,text,text,text,text,timestamptz)','EXECUTE'); -- false
select has_function_privilege('service_role',
  'public.ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz)','EXECUTE'); -- true
-- Each function pins search_path (EXT-3):
select proname from pg_proc p
  where proname in ('ourmtg_task_create','ourmtg_task_transition','ourmtg_document_finalize_submit')
  and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'); -- all 3
```

## 5. Atomicity, immutability, idempotency (SQL) — EXT-5/EXT-8/EXT-12
Pick an org + loan_file on the branch (`:org`, `:file`, `:lo_user`), then:
```sql
-- CREATE (note Rev 2 arg order incl. p_responsible_user_id, p_shared_with_borrowers, p_request_hash):
select public.ourmtg_task_create(:org,:file,'document_request','Upload pay stubs',
  'Please upload your last 30 days','UW: 30d paystubs','borrower', null, true, 'normal', true, null,
  'paystubs_30d', :lo_user,'loan_officer',:lo_user,'ourmtg','corr-1','idem-create-1','hash-create-1', now());
-- one task + one history(created) + one domain event + one notification.queued intent (EXT-9):
select (select count(*) from loan_tasks),
       (select count(*) from loan_task_history),
       (select count(*) from loan_events where event_type='task.created'),
       (select count(*) from loan_events where event_type='notification.queued'); -- 1,1,1,1

-- IMMUTABILITY (EXT-12): expect ERROR
update public.loan_events set event_type='x' where true;      -- must RAISE
delete from public.loan_task_history where true;              -- must RAISE

-- AUDIT RETENTION (EXT-12): deleting a task is BLOCKED while history references it (ON DELETE RESTRICT)
delete from public.loan_tasks where id = :task;               -- must RAISE (foreign_key_violation)

-- IDEMPOTENCY same key + SAME hash → deduped, no new rows (EXT-8):
select public.ourmtg_task_create(:org,:file,'document_request','Upload pay stubs',
  'Please upload your last 30 days','UW: 30d paystubs','borrower', null, true, 'normal', true, null,
  'paystubs_30d', :lo_user,'loan_officer',:lo_user,'ourmtg','corr-1','idem-create-1','hash-create-1', now());
-- IDEMPOTENCY same key + DIFFERENT hash → ERROR idempotency_conflict (EXT-8):
select public.ourmtg_task_create(:org,:file,'document_request','DIFFERENT TITLE',
  null,null,'borrower',null,true,'normal',false,null,null,:lo_user,'loan_officer',:lo_user,'ourmtg',
  'corr-1','idem-create-1','hash-create-2', now());                                   -- must RAISE
```

## 6. EXT-4 — stale-state concurrency (revision guard)
```sql
-- read current revision, then transition with the WRONG expected revision → stale_task:
select revision from public.loan_tasks where id = :task;      -- say it is 0
select public.ourmtg_task_transition(:task,'assign', 0,'loan_officer',:lo_user,:org,
  null,null,null,null,'idem-tr-1','hash-tr-1','corr-1','ourmtg', now());              -- OK, revision → 1
-- a second writer that still believes revision 0 (distinct key) must be REJECTED with zero writes:
select public.ourmtg_task_transition(:task,'cancel', 0,'loan_officer',:lo_user,:org,
  null,null,null,null,'idem-tr-2','hash-tr-2','corr-1','ourmtg', now());              -- must RAISE stale_task
-- caller may NOT force a status/event: transition takes p_action only; the DB derives to-status + event.
-- FCG-2.5: a reject / more-info WITHOUT a borrower-visible reason must RAISE reason_required (with a
-- submitted task at :sub_rev):
select public.ourmtg_task_transition(:task,'reject', :sub_rev,'loan_officer',:lo_user,:org,
  null, null, null, null,'idem-noreason','hash-noreason','corr-1','ourmtg', now());   -- must RAISE reason_required
```

## 7. EXT-5 — atomic document finalize + submit
```sql
-- with a borrower task in an in_progress state and a document on the SAME loan file:
select public.ourmtg_document_finalize_submit(:doc,:task,:org,:borrower_user,'borrower',
  :expected_rev,'idem-fin-1','hash-fin-1','corr-1','ourmtg', now());
-- doc.uploaded + task.submitted + history + event, all-or-nothing:
select (select status from loan_documents where id=:doc),
       (select status from loan_tasks where id=:task);        -- 'uploaded','submitted'
-- cross-loan document → ERROR cross_loan_document, NOTHING changes:
select public.ourmtg_document_finalize_submit(:doc_other_loan,:task,:org,:borrower_user,'borrower',
  :expected_rev,'idem-fin-2','hash-fin-2','corr-1','ourmtg', now());                  -- must RAISE
```

## 8. End-to-end (preview app, 2 test accounts) — EXT-1/6/7
1. LO account (member of the file's org): open a loan file → "Borrower tasks (pilot)" → create a document
   task; choose **Shared with all borrowers** or a specific participant (EXT-7).
2. Borrower account (invited to that file): "Needs your attention" shows the task (title, explanation,
   blocking, action). `internal_requirement` is absent (inspect the network payload).
3. Borrower opens the task → Documents (`?task=<id>`) → uploads → task becomes `submitted` atomically.
4. Borrower attempts accept via API → `403` (`forbidden_action`).
5. LO: To review → **Reject with a borrower-visible reason** → borrower sees the localized reason
   (EXT-6). Borrower resubmits → the reason clears.
6. A **second borrower** on the SAME file who is NOT the targeted participant does NOT see a
   participant-scoped task; a shared task is visible to both (EXT-7).
7. Another borrower (different file) requests the task id → `403`. Realtor → `403`.
8. Cross-org: a member of a different org requesting the task → `403` (`Cross-organization access denied`).
9. Flags OFF (unset `FF_TASK_PILOT`, `FF_LOAN_TEAM_TASK_PILOT`): every task endpoint returns `404`
   (EXT-10 fail-closed).

## 9. Rollback (branch)
Run the commented `-- ROLLBACK` block from the migration (drops RPCs, tables, `loan_files.organization_id`,
guard fn in reverse dependency order).

## Acceptance = all of the above pass on the branch.
Do not promote to production or `supabase/migrations/` without owner sign-off. **Status: NOT RUN** — no
isolated branch database has been provided; the fake-adapter suite (`npm test`) is not a substitute for
this live acceptance.
