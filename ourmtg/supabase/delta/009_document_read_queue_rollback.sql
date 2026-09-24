-- OurMTG Delta 009 — ROLLBACK
--
-- Removes the document read queue and returns the product to the behavior it had before delta
-- 009: documents are read only when an internal user presses the button on the pre-underwriting
-- panel, and no automatic borrower follow-up is sent.
--
-- ── Why this is safe ────────────────────────────────────────────────────────
-- Nothing references document_read_jobs. Its two foreign keys point OUT (loan_files,
-- loan_documents) and no other table, view, function, trigger or policy points back at it, so
-- the drop needs no CASCADE and can orphan nothing. It also holds no conclusions: a row says a
-- read is OWED, never what the read found. Everything a read produced lives in
-- document_extractions and pre_underwriting_findings and is untouched by this file.
--
-- Concretely, dropping this table loses only the knowledge of which reads were still pending.
-- Those documents remain on the file, unread, and the panel's manual read recovers every one of
-- them.
--
-- ── ORDER MATTERS ───────────────────────────────────────────────────────────
-- Stop the worker BEFORE running this, or it will spend a minute at a time erroring against a
-- table that no longer exists. Either is enough:
--
--   1. set PRE_UNDERWRITING_ENABLED=false   (the worker 404s immediately, before any query), or
--   2. remove/disable the pre-underwriting-read-worker scheduled function and redeploy.
--
-- Option 1 is faster and is the one to reach for in an incident.
--
-- ── What happens if you DON'T stop the worker first ─────────────────────────
-- Nothing is corrupted; it is merely noisy. listQueued throws, the worker's own try/catch
-- catches it, and the invocation returns 500. No borrower sees anything. The upload path is
-- unaffected: enqueueRead is fail-soft by contract, so an upload against a missing table still
-- succeeds and simply does not queue a read. readStateForFile returns an empty result on error,
-- so the borrower workspace and the internal panel both keep rendering.
--
-- Safe to run twice.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Refuse to run against a database that is not this product, exactly as the forward delta does.
do $$
begin
  if to_regclass('public.loan_documents') is null then
    raise exception 'Wrong or incomplete project: public.loan_documents is missing';
  end if;
end;
$$;

-- Fail loudly rather than silently orphaning, if some future object ever does depend on this.
do $$
declare
  dependents text;
begin
  if to_regclass('public.document_read_jobs') is null then
    return;
  end if;
  select string_agg(distinct c.relname, ', ')
    into dependents
    from pg_constraint fk
    join pg_class c on c.oid = fk.conrelid
   where fk.contype = 'f'
     and fk.confrelid = 'public.document_read_jobs'::regclass;
  if dependents is not null then
    raise exception 'Refusing to drop: % still reference document_read_jobs', dependents;
  end if;
end;
$$;

-- The indexes go with the table; naming them is documentation, not a second step.
--   document_read_jobs_live_doc_idx   (unique, partial: status in queued/running)
--   document_read_jobs_queue_idx      (partial: status in queued/running)
--   document_read_jobs_file_idx
drop table if exists public.document_read_jobs;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select case
         when to_regclass('public.document_read_jobs') is null
              and (select count(*) from pg_indexes
                    where schemaname = 'public'
                      and indexname like 'document_read_jobs%')::int = 0
              and to_regclass('public.document_extractions') is not null
              and to_regclass('public.pre_underwriting_findings') is not null
              and to_regclass('public.loan_documents') is not null
           then 'PASS - queue removed; extractions, findings and documents untouched'
         else 'FAIL - table_gone=' || (to_regclass('public.document_read_jobs') is null)::text
              || ' stray_indexes=' || (select count(*) from pg_indexes
                   where schemaname = 'public' and indexname like 'document_read_jobs%')::text
              || ' extractions_present=' || (to_regclass('public.document_extractions') is not null)::text
       end as result;
