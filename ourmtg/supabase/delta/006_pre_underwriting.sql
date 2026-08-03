-- OurMTG Delta 006 — Autopilot Pre-Underwriting: what was read, and what was concluded
--
-- Two tables, and the line between them is the whole architecture:
--
--   document_extractions      what Level 2 READ out of a document. Facts with confidences.
--                             No conclusions. Never a decision.
--   pre_underwriting_findings what Level 3 CONCLUDED from those facts, by rule, with the
--                             evidence it stands on. Still not a decision — a finding is a
--                             question put to a person, and the person's answer is recorded
--                             on the same row.
--
-- Keeping them apart is what makes "why did this appear?" answerable. Collapse them and you
-- get a single opaque score that nobody can audit, re-check when a document is replaced, or
-- recount when a program's rules change.
--
-- SERVER-ONLY, like every other table since 003: RLS on, all anon/authenticated privileges
-- revoked. The browser reaches this only through authorized gateway functions.
--
-- WHAT IS DELIBERATELY ABSENT
--   • No approve/deny column, anywhere. Nothing in this schema can express an underwriting
--     decision, because nothing in this product is allowed to make one. A reviewer confirms,
--     corrects, or dismisses a FINDING; that is the whole vocabulary.
--   • No borrower-visible flag. Findings characterize the applicant, which is the line
--     borrower-facing output does not cross (docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md). What
--     reaches a borrower is a document request, computed from completeness, not stored here.
--   • No plaintext identity values. Level 2 refuses SSNs before they get this far; there is
--     no column here for one to land in.
--
-- Safe to run twice. Creates tables; touches no existing row.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Refuse to run against a database that is not this product.
do $$
begin
  if to_regclass('public.loan_files') is null
     or to_regclass('public.loan_documents') is null then
    raise exception 'Wrong or incomplete project: OurMTG core is missing';
  end if;
end;
$$;

-- ── What the model read out of one uploaded document ─────────────────────────
-- One row per READ, not per document. Re-reading after a better scan arrives appends a new
-- row and supersedes the old one, so the history of what we believed, and when, survives —
-- the same reason application_field_events is append-only.
create table if not exists public.document_extractions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid,
  loan_file_id      uuid not null references public.loan_files(id) on delete cascade,
  document_id       uuid not null references public.loan_documents(id) on delete cascade,

  -- Null means the model could not place it in the catalog. That is an ordinary outcome and
  -- must stay expressible: a wrong doc_key is worse than none, because it satisfies a
  -- checklist slot that is in fact still empty.
  doc_key           text,
  proposed_doc_key  text,
  doc_key_confidence numeric check (doc_key_confidence is null
                                    or (doc_key_confidence >= 0 and doc_key_confidence <= 1)),
  expected_doc_key  text,
  doc_key_mismatch  boolean not null default false,
  legible           boolean not null default true,

  -- The validated fields, exactly as extractionContract.js produced them: name, value,
  -- confidence, rawText, page. jsonb rather than a table of its own — they are read as a set,
  -- never queried individually, and a row per field would be a join for no gain.
  fields            jsonb not null default '[]'::jsonb,
  field_count       integer not null default 0,
  -- The weakest link, not an average: a conclusion is only as good as the shakiest number
  -- under it, and averaging lets three confident reads paper over one bad one.
  min_field_confidence numeric check (min_field_confidence is null
                                      or (min_field_confidence >= 0 and min_field_confidence <= 1)),
  rejected          jsonb not null default '[]'::jsonb,
  notes             text,

  needs_human_review boolean not null default true,
  review_reasons     text[] not null default '{}',

  -- Provenance. Which model, which prompt, which catalog — so a finding produced last quarter
  -- can still be explained after all three have moved on.
  provider_name     text,
  provider_model    text,
  prompt_version    text,
  catalog_version   text,
  input_tokens      integer,
  output_tokens     integer,
  duration_ms       integer,

  superseded_by     uuid references public.document_extractions(id) on delete set null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists document_extractions_file_idx on public.document_extractions(loan_file_id);
create index if not exists document_extractions_doc_idx  on public.document_extractions(document_id, created_at desc);
-- The reviewer's queue: what is waiting on a person, newest first.
create index if not exists document_extractions_review_idx
  on public.document_extractions(loan_file_id, created_at desc)
  where needs_human_review and superseded_by is null;

alter table public.document_extractions enable row level security;
revoke all privileges on table public.document_extractions from anon, authenticated;

-- ── What the rules concluded, and what a human decided about it ──────────────
create table if not exists public.pre_underwriting_findings (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid,
  loan_file_id      uuid not null references public.loan_files(id) on delete cascade,

  rule              text not null,
  category          text not null
                    check (category in ('income','employment','assets','liabilities',
                                        'identity','property','documents')),
  severity          text not null check (severity in ('low','medium','high')),

  -- Written for a reviewer, in facts: not "Income mismatch" but "income requires review
  -- because the paystub, the W-2 and the application cover different qualifying periods".
  explanation       text not null,

  -- Every field the rule read, with the document it came from and how sure the extraction
  -- was. This is what makes a finding auditable rather than an assertion.
  evidence          jsonb not null default '[]'::jsonb,
  source_documents  text[] not null default '{}',
  -- Deliberately NOT a confidence of the finding itself. Rules are deterministic: given these
  -- numbers the rule either fires or it does not. All the uncertainty is upstream, in whether
  -- the numbers were read correctly, so what is stored is the weakest evidence under it.
  min_confidence    numeric check (min_confidence is null
                                   or (min_confidence >= 0 and min_confidence <= 1)),
  needs_human_review boolean not null default true,

  status            text not null default 'pending_review'
                    check (status in ('pending_review','confirmed','corrected','dismissed')),
  resolved_by       uuid references auth.users(id) on delete set null,
  resolved_at       timestamptz,
  resolution_note   text,
  corrected_fields  jsonb,

  -- Which ruleset produced it. A finding that no longer reproduces under today's rules is a
  -- fact about the rules, and you cannot see that without knowing which ones ran.
  rules_version     text,
  catalog_version   text,
  -- One live finding per rule per file: a re-run replaces rather than accumulates, or the
  -- reviewer's queue fills with the same sentence forty times.
  run_id            uuid,
  superseded_by     uuid references public.pre_underwriting_findings(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists pre_underwriting_findings_file_idx
  on public.pre_underwriting_findings(loan_file_id, created_at desc);
create index if not exists pre_underwriting_findings_open_idx
  on public.pre_underwriting_findings(loan_file_id, severity)
  where status = 'pending_review' and superseded_by is null;
-- A rule fires at most once per file among live findings. Enforced, not merely intended.
create unique index if not exists pre_underwriting_findings_live_rule_idx
  on public.pre_underwriting_findings(loan_file_id, rule)
  where superseded_by is null;

alter table public.pre_underwriting_findings enable row level security;
revoke all privileges on table public.pre_underwriting_findings from anon, authenticated;

-- A decision must say who made it. Half a resolution — dismissed by nobody, at no time — is
-- exactly the record that cannot be defended later.
alter table public.pre_underwriting_findings
  drop constraint if exists pre_underwriting_findings_resolution_complete;
alter table public.pre_underwriting_findings
  add constraint pre_underwriting_findings_resolution_complete
  check (
    status = 'pending_review'
    or (resolved_by is not null and resolved_at is not null)
  );

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select case
         when tables = 2 and rls and browser = 0 and live_rule = 1
           then 'PASS - pre-underwriting storage created, server-only, one live finding per rule'
         else 'FAIL - tables=' || tables::text || ' rls=' || rls::text
              || ' browser_grants=' || browser::text || ' unique_rule_index=' || live_rule::text
       end as result
from (
  select
    (select count(*) from information_schema.tables
      where table_schema = 'public'
        and table_name in ('document_extractions','pre_underwriting_findings')) as tables,
    (select bool_and(relrowsecurity) from pg_class where oid in (
       'public.document_extractions'::regclass,
       'public.pre_underwriting_findings'::regclass)) as rls,
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated')
        and table_name in ('document_extractions','pre_underwriting_findings')) as browser,
    (select count(*) from pg_indexes
      where schemaname = 'public'
        and indexname = 'pre_underwriting_findings_live_rule_idx') as live_rule
) q;
