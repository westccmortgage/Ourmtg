-- OurMTG Delta 007 — a finding's identity is the finding, not its rule
--
-- THE BUG THIS FIXES: delta 006 enforced one live finding per (loan_file_id, rule). But a rule
-- is not a finding — undisclosed_liability legitimately fires once PER CREDITOR, so a file with
-- two undisclosed debts violated the index on the second insert and the whole document intake
-- failed with a 500. Found by an end-to-end regression test on 2026-08-06; reproduces on any
-- real file with more than one undisclosed obligation.
--
-- THE FIX: findings already carry a deterministic identity — a hash of (loan_file_id, rule,
-- seed), where the seed names the specific subject ("undisclosed_liability:discover"). That
-- identity becomes a stored column, and the one-live-row guarantee moves onto it. The guarantee
-- delta 006 wanted — a re-run replaces rather than stacking duplicates — is preserved exactly;
-- what changes is only WHAT counts as "the same finding".
--
-- Also fixed by the same key: keep-decided logic. A human's dismissal of the Discover finding
-- must not swallow a brand-new Amex finding just because both share a rule name.
--
-- Safe to run twice. Adds a column and swaps an index; touches rows only to backfill the key.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.pre_underwriting_findings') is null then
    raise exception 'Wrong or incomplete project: delta 006 (pre-underwriting) has not been applied';
  end if;
end;
$$;

alter table public.pre_underwriting_findings
  add column if not exists dedupe_key text;

-- Existing rows: the rule name is the best identity available in retrospect, and matches what
-- the old index enforced, so nothing changes meaning during the backfill.
update public.pre_underwriting_findings set dedupe_key = rule where dedupe_key is null;

alter table public.pre_underwriting_findings
  alter column dedupe_key set not null;

drop index if exists pre_underwriting_findings_live_rule_idx;

create unique index if not exists pre_underwriting_findings_live_key_idx
  on public.pre_underwriting_findings(loan_file_id, dedupe_key)
  where superseded_by is null;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select case
         when has_col and new_idx = 1 and old_idx = 0
           then 'PASS - findings are unique per finding, not per rule'
         else 'FAIL - dedupe_key=' || has_col::text || ' new_index=' || new_idx::text
              || ' old_index_still_present=' || old_idx::text
       end as result
from (
  select
    exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'pre_underwriting_findings'
        and column_name = 'dedupe_key') as has_col,
    (select count(*) from pg_indexes where schemaname = 'public'
      and indexname = 'pre_underwriting_findings_live_key_idx') as new_idx,
    (select count(*) from pg_indexes where schemaname = 'public'
      and indexname = 'pre_underwriting_findings_live_rule_idx') as old_idx
) q;
