-- OurMTG Delta 004 — a loan file must outlive the account that created it
--
-- WHY THIS EXISTS: on 2026-08-02 every loan file in the live project disappeared. Not by a
-- DELETE against loan_files — by deleting the auth users who owned them. loan_files.owner_user_id
-- was declared `references auth.users(id) on delete cascade`, so removing an account silently
-- took its files, documents, conditions, messages, invitations, and applications with it.
--
-- The evidence was the audit log: 33 rows survived with loan_file_id nulled, because
-- portal_access_log alone was declared `on delete set null`. Everything that mattered had
-- already been cascaded away.
--
-- A mortgage file is a record a lender is required to retain for years. It must not be
-- destructible as a side effect of tidying up an account — least of all silently, from a
-- dashboard, with no confirmation that anything else was attached.
--
-- WHAT CHANGES: exactly one constraint. Deleting a user who still owns loan files now fails
-- with a foreign-key violation instead of taking the files down. To remove such a user, the
-- files have to be dealt with first — deliberately, as their own act.
--
-- WHAT DOES NOT CHANGE: everything hanging off a loan file still cascades from the loan file.
-- Deleting a file is still supposed to remove its documents and conditions; that has always
-- been correct and stays. This only stops a file from being deleted by proxy.
--
-- Safe to run twice. Rewrites a constraint; touches no rows.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

-- Refuse to run against a database that is not this product.
do $$
begin
  if to_regclass('public.loan_files') is null then
    raise exception 'Wrong or incomplete project: OurMTG core is missing';
  end if;
end;
$$;

-- The constraint is the one Postgres generated for the inline REFERENCES in the baseline. Find
-- it by what it points at rather than by name, so this works whatever it ended up called.
do $$
declare
  fk_name text;
begin
  select con.conname into fk_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'loan_files'
    and con.contype = 'f'
    and con.confrelid = 'auth.users'::regclass
    and con.conkey = array[(
      select attnum from pg_attribute
      where attrelid = rel.oid and attname = 'owner_user_id'
    )]::smallint[]
  limit 1;

  if fk_name is not null then
    execute format('alter table public.loan_files drop constraint %I', fk_name);
  end if;
end;
$$;

alter table public.loan_files
  add constraint loan_files_owner_user_id_fkey
  foreign key (owner_user_id) references auth.users(id) on delete restrict;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
-- 'r' = restrict. Anything else means the protection is not in place.
select case
         when confdeltype = 'r'
           then 'PASS - deleting a user who owns loan files is now refused'
         -- confdeltype is "char", not text; concatenating it without a cast is ambiguous and
         -- Postgres rejects the whole CASE at parse time, even down the branch that passes.
         else 'FAIL - loan_files still deletes by cascade (confdeltype=' || confdeltype::text || ')'
       end as result
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname = 'loan_files'
  and con.contype = 'f'
  and con.confrelid = 'auth.users'::regclass;
