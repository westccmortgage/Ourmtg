#!/usr/bin/env bash
# Migration rehearsal — prove the migration chain executes before touching a real project.
#
# Spins up a throwaway Postgres database, applies the Supabase shim + the full migration chain
# in order, then asserts the things only a real database can prove: constraints reject bad data,
# unique keys hold, cascades cascade, and the rollback is clean.
#
# Usage:   ./supabase/rehearsal/run-rehearsal.sh
# Requires: a running local Postgres and psql. Nothing here ever touches a real project — the
# guard clause inside 003 additionally refuses any database that is not OurMTG.
#
# WHAT THIS DOES NOT PROVE: how RLS behaves under a real anon/authenticated JWT, GoTrue, or the
# storage API. Those still require a real Supabase project.

set -euo pipefail

HOST="${PGHOST:-127.0.0.1}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-postgres}"
DBNAME="${REHEARSAL_DB:-rehearsal}"
ADMIN="postgresql://${USER}@${HOST}:${PORT}/postgres"
DB="postgresql://${USER}@${HOST}:${PORT}/${DBNAME}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
# Assert a statement fails with an expected error fragment.
# psql exits non-zero on the errors we are deliberately provoking, and `set -o pipefail` would
# make the pipeline look failed even when grep matched. Capture first, then match.
rejects() { # <description> <sql> <expected fragment>
  local out
  out="$(psql -qtA "$DB" -c "$2" 2>&1 || true)"
  if grep -qF "$3" <<<"$out"; then ok "$1"; else bad "$1 -- got: $(head -1 <<<"$out")"; fi
}
scalar() { psql -qtA "$DB" -c "$1"; }

echo "== resetting ${DBNAME} =="
psql -q "$ADMIN" -c "drop database if exists ${DBNAME};" -c "create database ${DBNAME};" >/dev/null

echo "== applying shim + migration chain =="
for f in \
  "${HERE}/00_supabase_shim.sql" \
  "${ROOT}/supabase/baseline/001_ourmtg_core.sql" \
  "${ROOT}/supabase/delta/001_live_core_hardening.sql" \
  "${ROOT}/supabase/delta/002_statement_income_analysis.sql" \
  "${ROOT}/supabase/delta/003_conversational_1003.sql"
do
  name="$(basename "$f")"
  if psql -v ON_ERROR_STOP=1 -q "$DB" -f "$f" >/dev/null 2>/tmp/rehearsal_err; then
    ok "applied ${name}"
  else
    bad "applied ${name}"; sed -n '1,5p' /tmp/rehearsal_err
  fi
done

echo "== 003 verification query =="
V=$(scalar "select jsonb_build_object(
  'n', (select count(*) from information_schema.tables where table_schema='public'
        and table_name in ('mortgage_applications','application_parties','application_field_events',
                           'application_field_state','application_turns','application_secure_fields',
                           'application_attestations')),
  'rls', (select bool_and(relrowsecurity) from pg_class where oid in (
            'public.mortgage_applications'::regclass,'public.application_parties'::regclass,
            'public.application_field_events'::regclass,'public.application_field_state'::regclass,
            'public.application_turns'::regclass,'public.application_secure_fields'::regclass,
            'public.application_attestations'::regclass)),
  'browser', (select count(*) from information_schema.role_table_grants
              where table_schema='public' and grantee in ('anon','authenticated')
              and table_name like any (array['application%','mortgage_applications'])))")
[ "$(echo "$V" | grep -o '"n": 7')" ] && ok "all 7 tables created" || bad "table count: $V"
[ "$(echo "$V" | grep -o '"rls": true')" ] && ok "RLS enabled on every table" || bad "RLS: $V"
[ "$(echo "$V" | grep -o '"browser": 0')" ] && ok "no anon/authenticated privileges" || bad "browser grants: $V"

echo "== re-running 003 (must be idempotent) =="
if psql -v ON_ERROR_STOP=1 -q "$DB" -f "${ROOT}/supabase/delta/003_conversational_1003.sql" >/dev/null 2>&1
  then ok "003 is safe to re-run"; else bad "003 is not idempotent"; fi

echo "== guard clause refuses a foreign database =="
psql -q "$ADMIN" -c "drop database if exists rehearsal_wrong;" -c "create database rehearsal_wrong;" >/dev/null
GUARD_OUT="$(psql -v ON_ERROR_STOP=1 "postgresql://${USER}@${HOST}:${PORT}/rehearsal_wrong" \
     -f "${ROOT}/supabase/delta/003_conversational_1003.sql" 2>&1 || true)"
if grep -q "Wrong or incomplete project" <<<"$GUARD_OUT"
  then ok "guard refuses a non-OurMTG database"; else bad "guard did not fire"; fi
psql -q "$ADMIN" -c "drop database if exists rehearsal_wrong;" >/dev/null

echo "== seeding fixtures =="
LO=11111111-1111-4111-8111-111111111111
LF=22222222-2222-4222-8222-222222222222
APP=33333333-3333-4333-8333-333333333333
PARTY=44444444-4444-4444-8444-444444444444
psql -q "$DB" >/dev/null <<SQL
insert into auth.users (id,email) values ('${LO}','lo@example.com') on conflict do nothing;
insert into loan_files (id,owner_user_id,source_deal_id,borrower_name)
  values ('${LF}','${LO}','manual_rehearsal','Fictional Borrower') on conflict do nothing;
insert into mortgage_applications (id,loan_file_id,schema_version,catalog_version,rules_version)
  values ('${APP}','${LF}','v1','v1','v1') on conflict do nothing;
insert into application_parties (id,application_id,loan_file_id,party_index,party_role)
  values ('${PARTY}','${APP}','${LF}',0,'borrower') on conflict do nothing;
insert into application_turns (application_id,loan_file_id,idempotency_key,request_hash)
  values ('${APP}','${LF}','key-1','hash-1') on conflict do nothing;
insert into application_field_state (application_id,loan_file_id,field_path,status,source)
  values ('${APP}','${LF}','loan.purpose','candidate','borrower_text') on conflict do nothing;
SQL

SEEDED=$(scalar "select (select count(*) from mortgage_applications)+(select count(*) from application_parties)
                 +(select count(*) from application_turns)+(select count(*) from application_field_state);")
[ "$SEEDED" = "4" ] && ok "fixtures seeded (cascade check below is meaningful)" \
  || bad "seeding produced ${SEEDED} rows, expected 4 -- the cascade check would be a false pass"

echo "== constraints =="
rejects "unknown loan_file is rejected" \
  "insert into mortgage_applications (loan_file_id,schema_version,catalog_version,rules_version)
   values ('00000000-0000-4000-8000-000000000999','v','v','v');" "violates foreign key constraint"
rejects "one application per loan file + version" \
  "insert into mortgage_applications (loan_file_id,application_version,schema_version,catalog_version,rules_version)
   values ('${LF}',1,'v','v','v');" "duplicate key value violates unique constraint"
rejects "idempotency key cannot repeat (double-submit protection)" \
  "insert into application_turns (application_id,loan_file_id,idempotency_key,request_hash)
   values ('${APP}','${LF}','key-1','hash-2');" "duplicate key value violates unique constraint"
rejects "one party per index" \
  "insert into application_parties (application_id,loan_file_id,party_index,party_role)
   values ('${APP}','${LF}',0,'borrower');" "duplicate key value violates unique constraint"
rejects "field status is a closed vocabulary" \
  "insert into application_field_events (application_id,loan_file_id,field_path,template_path,status,source,application_version,catalog_version)
   values ('${APP}','${LF}','p','p','not_a_status','borrower_text','v','v');" "violates check constraint"
rejects "field source is a closed vocabulary" \
  "insert into application_field_events (application_id,loan_file_id,field_path,template_path,status,source,application_version,catalog_version)
   values ('${APP}','${LF}','p','p','candidate','made_up_source','v','v');" "violates check constraint"
rejects "confidence must be 0..1" \
  "insert into application_field_events (application_id,loan_file_id,field_path,template_path,status,source,confidence,application_version,catalog_version)
   values ('${APP}','${LF}','p','p','candidate','borrower_text',5.0,'v','v');" "violates check constraint"
rejects "secure last_four must be exactly four digits" \
  "insert into application_secure_fields (application_id,party_id,loan_file_id,field_path,last_four,value_digest)
   values ('${APP}','${PARTY}','${LF}','p','12345','d');" "violates check constraint"
rejects "turn processing_state is a closed vocabulary" \
  "insert into application_turns (application_id,loan_file_id,idempotency_key,request_hash,processing_state)
   values ('${APP}','${LF}','key-2','h','not_a_state');" "violates check constraint"

echo "== cascade =="
psql -q "$DB" -c "delete from loan_files where id='${LF}';" >/dev/null
LEFT=$(scalar "select (select count(*) from mortgage_applications)+(select count(*) from application_parties)
               +(select count(*) from application_turns)+(select count(*) from application_field_state);")
[ "$LEFT" = "0" ] && ok "deleting the loan file removes all application data" || bad "orphan rows left: $LEFT"

echo "== rollback =="
if psql -v ON_ERROR_STOP=1 -q "$DB" -c "begin;
  drop table application_attestations, application_secure_fields, application_turns,
             application_field_state, application_field_events, application_parties,
             mortgage_applications; commit;" >/dev/null 2>&1
  then ok "rollback drops cleanly in dependency order"; else bad "rollback failed"; fi
KEPT=$(scalar "select count(*) from information_schema.tables where table_schema='public'
               and table_name in ('loan_files','portal_access','loan_documents','statement_income_analyses');")
[ "$KEPT" = "4" ] && ok "pre-existing tables untouched by the rollback" || bad "pre-existing tables affected: $KEPT"

echo
echo "==================== ${pass} passed, ${fail} failed ===================="
[ "$fail" -eq 0 ] || exit 1
