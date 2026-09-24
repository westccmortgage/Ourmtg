-- OurMTG Delta 009 — the borrower's upload reads itself
--
-- WHAT THIS IS FOR. Until now a document was read only when an internal user opened the panel
-- and pressed a button. That made the expensive half of the workflow human-triggered: borrower
-- uploads → someone notices → someone reads it → someone discovers page 6 is missing → someone
-- calls the borrower. This table is what removes the four "someone"s from routine iterations.
-- An upload enqueues a read; a worker drains the queue; the borrower's checklist updates itself
-- and asks for exactly what is still missing.
--
-- WHY A TABLE AND NOT A FIRE-AND-FORGET PROMISE. The upload endpoint runs in a function that is
-- frozen the instant it responds, and a model read takes tens of seconds. Work started but not
-- awaited would be killed mid-flight, silently, on exactly the uploads that matter. A row is
-- durable: if the worker crashes, the job is still queued; if the worker is slow, nothing is
-- lost; if the read fails for a real reason, the reason is recorded against the document rather
-- than disappearing into a log nobody reads.
--
-- WHAT IS DELIBERATELY ABSENT
--   • No result column. This table says a read is OWED, never what the read concluded. The
--     conclusions live in document_extractions and pre_underwriting_findings, which already
--     have their supersede/audit semantics. A second home for the same facts would drift.
--   • No borrower-visible flag, and no borrower-visible text. A borrower sees that their upload
--     is being reviewed; the mechanism is not theirs to read.
--
-- SERVER-ONLY, like every table since 003: RLS on, all anon/authenticated privileges revoked.
-- Nothing in the browser touches this; the worker and the upload endpoint reach it with the
-- service role.
--
-- Safe to run twice. Creates one table and its indexes; touches no existing row.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Refuse to run against a database that is not this product.
do $$
begin
  if to_regclass('public.loan_documents') is null then
    raise exception 'Wrong or incomplete project: public.loan_documents is missing';
  end if;
  if to_regclass('public.document_extractions') is null then
    raise exception 'Wrong or incomplete project: delta 006 (pre-underwriting) has not been applied';
  end if;
end;
$$;

create table if not exists public.document_read_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid,
  loan_file_id    uuid not null references public.loan_files(id) on delete cascade,
  document_id     uuid not null references public.loan_documents(id) on delete cascade,

  -- queued  → owed, nobody has it
  -- running → a worker claimed it; claimed_at bounds how long that claim is believed
  -- done    → read and stored
  -- failed  → gave up after max_attempts, or hit a settled answer (a refusal, an unreadable
  --           format). Either way a person has to look, and last_error_code says why.
  status          text not null default 'queued'
                    check (status in ('queued','running','done','failed')),
  attempts        int  not null default 0,
  max_attempts    int  not null default 3,

  -- Who caused the read to be owed. Not an authorization — the worker uses the service role
  -- either way — but a processor asking "why was this read at 2am?" deserves an answer.
  requested_by    text not null default 'borrower_upload'
                    check (requested_by in ('borrower_upload','loan_team','system')),

  last_error      text,
  last_error_code text,
  correlation_id  text,

  created_at      timestamptz not null default now(),
  claimed_at      timestamptz,
  finished_at     timestamptz
);

-- One live job per document. A borrower who taps upload twice, or a retry that lands while the
-- first attempt is still running, must not cause the same PDF to be read (and billed) twice.
create unique index if not exists document_read_jobs_live_doc_idx
  on public.document_read_jobs(document_id)
  where status in ('queued','running');

-- The worker's only query: oldest queued first.
create index if not exists document_read_jobs_queue_idx
  on public.document_read_jobs(status, created_at)
  where status in ('queued','running');

create index if not exists document_read_jobs_file_idx
  on public.document_read_jobs(loan_file_id, created_at desc);

alter table public.document_read_jobs enable row level security;
revoke all on public.document_read_jobs from anon, authenticated;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select case
         when tbl and rls and live_idx = 1 and not anon_priv
           then 'PASS - read queue exists, RLS on, one live job per document, no client access'
         else 'FAIL - table=' || tbl::text || ' rls=' || rls::text
              || ' live_index=' || live_idx::text || ' anon_or_authenticated_privileges=' || anon_priv::text
       end as result
from (
  select
    to_regclass('public.document_read_jobs') is not null as tbl,
    coalesce((select c.relrowsecurity from pg_class c
              where c.oid = to_regclass('public.document_read_jobs')), false) as rls,
    (select count(*) from pg_indexes
      where schemaname = 'public' and indexname = 'document_read_jobs_live_doc_idx')::int as live_idx,
    exists (select 1 from information_schema.role_table_grants
             where table_schema = 'public' and table_name = 'document_read_jobs'
               and grantee in ('anon','authenticated')) as anon_priv
) q;
