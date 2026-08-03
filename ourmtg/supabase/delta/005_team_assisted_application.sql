-- OurMTG Delta 005 — record who took the application, and how
--
-- WHY THIS EXISTS: a loan officer taking an application over the phone is the ordinary case,
-- not an exception — it is how 1003s were taken for decades, and the URLA has a box for it:
-- "This application was taken by: Face-to-Face / Telephone / Internet / Mail."
--
-- Until now every turn in application_turns was attributed to a party and nothing recorded who
-- actually typed it. That was fine while only borrowers could answer. The moment the loan team
-- can answer on a borrower's behalf, an unattributed turn becomes a false record: it reads as
-- the borrower's own words in the transcript the team later reviews, and in anything exported.
--
-- WHAT CHANGES: two nullable columns on application_turns. Nothing is rewritten, nothing moves.
--
--   taken_by   null  = the party answered for themselves (every existing row, correctly)
--              uuid  = the internal user who took it on their behalf
--   taken_via  how the answers were collected, for the URLA box and for the audit trail
--
-- WHAT DOES NOT CHANGE: attestation. Only the borrower can attest, before and after this
-- migration, and application-attest still refuses anyone who is not borrower or co-borrower.
-- The team can collect the information; they cannot swear to it.
--
-- Field-level attribution already existed and is untouched: a value entered by the team lands
-- as source 'team_entry' with actor_user_id set, so the review screen can already say "not
-- borrower-stated". This adds the same truthfulness to the conversation log.
--
-- Safe to run twice. Adds columns; touches no rows.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Refuse to run against a database that is not this product, or one where delta 003 has not
-- been applied yet — the columns below have nothing to attach to.
do $$
begin
  if to_regclass('public.loan_files') is null then
    raise exception 'Wrong or incomplete project: OurMTG core is missing';
  end if;
  if to_regclass('public.application_turns') is null then
    raise exception 'Wrong or incomplete project: delta 003 (conversational 1003) has not been applied';
  end if;
end;
$$;

alter table public.application_turns
  add column if not exists taken_by uuid references auth.users(id) on delete set null;

alter table public.application_turns
  add column if not exists taken_via text;

-- A closed vocabulary, added separately so re-running the file cannot stack duplicate checks.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.application_turns'::regclass
      and conname = 'application_turns_taken_via_check'
  ) then
    alter table public.application_turns
      add constraint application_turns_taken_via_check
      check (taken_via is null or taken_via in ('self', 'phone', 'in_person', 'video'));
  end if;
end;
$$;

-- Reading the transcript by who took it is the query a reviewer actually runs ("what did the
-- team enter on this file?"), and it is the one an auditor runs too.
create index if not exists application_turns_taken_by_idx
  on public.application_turns(application_id, taken_by)
  where taken_by is not null;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select case
         when cols = 2 and chk = 1
           then 'PASS - the application log now records who took each turn'
         else 'FAIL - columns=' || cols::text || ' constraint=' || chk::text
       end as result
from (
  select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'application_turns'
        and column_name in ('taken_by', 'taken_via')) as cols,
    (select count(*) from pg_constraint
      where conrelid = 'public.application_turns'::regclass
        and conname = 'application_turns_taken_via_check') as chk
) q;
