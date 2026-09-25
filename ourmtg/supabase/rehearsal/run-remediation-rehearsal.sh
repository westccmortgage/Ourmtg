#!/usr/bin/env bash
# Remediation rehearsal — prove the path from where PRODUCTION ACTUALLY IS to where the audited
# release needs it to be.
#
# WHY THIS EXISTS. The rollout was approved on the understanding that deltas 001-008 were applied
# to the live project. On 2026-09-25 a read-back of the production database showed otherwise: it
# is at delta 006. `pre_underwriting_findings` has no `dedupe_key` column and still carries
# `pre_underwriting_findings_live_rule_idx`, the pre-007 index; none of delta 008's four tables
# exist. The audited code writes `dedupe_key` on every findings insert, so deploying onto that
# schema would fail every findings write on every document read.
#
# run-rehearsal.sh proves the chain 001..009 applied in order, from nothing. That is NOT the
# situation. This file proves the specific transition production would actually make:
#
#     a database at delta 006, WITH DATA IN IT  →  007  →  008  →  009
#
# and that the data survives, including the case delta 007 exists to fix.
#
# Usage:   ./supabase/rehearsal/run-remediation-rehearsal.sh
# Requires: a running local Postgres and psql. Never touches a real project.

set -euo pipefail

HOST="${PGHOST:-127.0.0.1}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-postgres}"
DBNAME="${REMEDIATION_DB:-remediation}"
ADMIN="postgresql://${USER}@${HOST}:${PORT}/postgres"
DB="postgresql://${USER}@${HOST}:${PORT}/${DBNAME}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
scalar() { psql -qtA "$DB" -c "$1"; }

LF='11111111-1111-4111-8111-111111111111'
LO='22222222-2222-4222-8222-222222222222'

echo "== resetting ${DBNAME} =="
psql -q "$ADMIN" -c "drop database if exists ${DBNAME};" -c "create database ${DBNAME};" >/dev/null

# ── Stage 1: build a database at exactly the production state (delta 006) ────
echo "== staging a replica at delta 006 (where production actually is) =="
for f in \
  "${HERE}/00_supabase_shim.sql" \
  "${ROOT}/supabase/baseline/001_ourmtg_core.sql" \
  "${ROOT}/supabase/delta/001_live_core_hardening.sql" \
  "${ROOT}/supabase/delta/002_statement_income_analysis.sql" \
  "${ROOT}/supabase/delta/003_conversational_1003.sql" \
  "${ROOT}/supabase/delta/004_protect_loan_files.sql" \
  "${ROOT}/supabase/delta/005_team_assisted_application.sql" \
  "${ROOT}/supabase/delta/006_pre_underwriting.sql"
do
  psql -v ON_ERROR_STOP=1 -q "$DB" -f "$f" >/dev/null 2>/tmp/remediation_err \
    || { bad "staging $(basename "$f")"; sed -n '1,5p' /tmp/remediation_err; exit 1; }
done
ok "replica staged at delta 006"

# The replica must look like production BEFORE we trust anything it tells us.
SHAPE="$(scalar "select
  (to_regclass('public.document_extractions') is not null)::text || '/' ||
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='pre_underwriting_findings'
       and column_name='dedupe_key')::text || '/' ||
  (select count(*) from pg_indexes where schemaname='public'
     and indexname='pre_underwriting_findings_live_rule_idx')::text || '/' ||
  (to_regclass('public.application_compliance_snapshots') is null)::text;")"
[ "$SHAPE" = "true/0/1/true" ] \
  && ok "replica matches production: 006 present, no dedupe_key, pre-007 index live, no 008 tables" \
  || bad "replica does NOT match production (got ${SHAPE}, expected true/0/1/true)"

# ── Stage 2: put data in it, the way production has data ────────────────────
echo "== seeding data that must survive the remediation =="
psql -q "$DB" >/dev/null 2>&1 <<SQL
insert into auth.users (id,email) values ('${LO}','lo@example.com') on conflict do nothing;
insert into loan_files (id,owner_user_id,source_deal_id,borrower_name)
  values ('${LF}','${LO}','manual_remediation','Fictional Borrower') on conflict do nothing;
insert into loan_documents (id,loan_file_id,owner_user_id,doc_key,label,status,storage_path)
  values ('00000000-0000-4000-8000-00000000d001','${LF}','${LO}','bank_2mo','bank_2mo','uploaded','f/a.pdf')
  on conflict do nothing;
-- A finding written the PRE-007 way: no dedupe_key, because the column does not exist yet.
insert into pre_underwriting_findings (loan_file_id,rule,category,severity,explanation,min_confidence)
  values ('${LF}','income_consistency','income','high','periods differ',0.82);
SQL
SEEDED="$(scalar "select count(*) from pre_underwriting_findings;")"
[ "$SEEDED" = "1" ] && ok "a pre-007 finding exists, so the backfill below is meaningful" \
  || bad "seeding failed (${SEEDED} findings)"

# The bug delta 007 fixes, demonstrated on the replica BEFORE the fix. Two undisclosed
# creditors is an ordinary file, and on this schema the second insert is refused.
BUG="$(psql -qtA "$DB" -c "insert into pre_underwriting_findings
  (loan_file_id,rule,category,severity,explanation)
  values ('${LF}','undisclosed_liability','liabilities','high','Discover'),
         ('${LF}','undisclosed_liability','liabilities','high','Amex');" 2>&1 || true)"
case "$BUG" in
  *"duplicate key value"*) ok "pre-007 defect reproduced on the replica: a file with two undisclosed debts is refused" ;;
  *) bad "expected the pre-007 unique-index failure, got: ${BUG}" ;;
esac

# ── Stage 3: the remediation itself ─────────────────────────────────────────
echo "== applying 007 -> 008 -> 009, in order =="
for f in \
  "${ROOT}/supabase/delta/007_finding_identity.sql" \
  "${ROOT}/supabase/delta/008_security_compliance_readiness.sql" \
  "${ROOT}/supabase/delta/009_document_read_queue.sql"
do
  name="$(basename "$f")"
  if psql -v ON_ERROR_STOP=1 -q "$DB" -f "$f" >/dev/null 2>/tmp/remediation_err; then
    ok "applied ${name}"
  else
    bad "applied ${name}"; sed -n '1,8p' /tmp/remediation_err
  fi
done

# ── Stage 4: did the data survive, and is the defect actually gone? ─────────
echo "== verifying the outcome =="
KEPT="$(scalar "select count(*) from pre_underwriting_findings where explanation='periods differ';")"
[ "$KEPT" = "1" ] && ok "the pre-existing finding survived the migration" || bad "finding lost: ${KEPT}"

BACKFILL="$(scalar "select dedupe_key from pre_underwriting_findings where explanation='periods differ';")"
[ "$BACKFILL" = "income_consistency" ] \
  && ok "delta 007 backfilled dedupe_key from the rule name, as designed" \
  || bad "backfill wrong: '${BACKFILL}'"

NULLS="$(scalar "select count(*) from pre_underwriting_findings where dedupe_key is null;")"
[ "$NULLS" = "0" ] && ok "no finding is left without an identity" || bad "${NULLS} findings have no dedupe_key"

OLDIDX="$(scalar "select count(*) from pg_indexes where schemaname='public'
  and indexname='pre_underwriting_findings_live_rule_idx';")"
[ "$OLDIDX" = "0" ] && ok "the pre-007 index is gone" || bad "pre-007 index still present"

# The same insert that was refused above must now succeed: that is the whole point of 007.
FIXED="$(psql -qtA "$DB" -c "insert into pre_underwriting_findings
  (loan_file_id,rule,category,severity,explanation,dedupe_key)
  values ('${LF}','undisclosed_liability','liabilities','high','Discover','ul:discover'),
         ('${LF}','undisclosed_liability','liabilities','high','Amex','ul:amex') returning 1;" 2>&1 | wc -l || true)"
[ "$FIXED" = "2" ] && ok "after 007, a file with two undisclosed debts is accepted" \
  || bad "the defect survived the remediation: ${FIXED}"

D008="$(scalar "select count(*) from information_schema.tables where table_schema='public'
  and table_name in ('document_security_assessments','compliance_catalog_versions',
                     'application_compliance_snapshots','record_retention_events');")"
[ "$D008" = "4" ] && ok "delta 008's four tables exist" || bad "delta 008 incomplete: ${D008}/4"

D009="$(scalar "select (to_regclass('public.document_read_jobs') is not null)::text || '/' ||
  (select count(*) from pg_indexes where schemaname='public'
     and indexname='document_read_jobs_live_doc_idx')::text;")"
[ "$D009" = "true/1" ] && ok "delta 009's queue and live-job index exist" || bad "delta 009 wrong: ${D009}"

# What the audited code actually does on every document read, run against the migrated schema.
WRITE="$(psql -qtA "$DB" -c "insert into pre_underwriting_findings
  (loan_file_id,rule,category,severity,explanation,dedupe_key,status,rules_version,catalog_version,run_id)
  values ('${LF}','large_deposit','assets','medium','a deposit needs sourcing','ld:1',
          'pending_review','pu-rules-1','pu-catalog-2-tax-return',
          '99999999-9999-4999-8999-999999999999') returning 1;" 2>&1 | tail -1 || true)"
[ "$WRITE" = "1" ] && ok "a findings write in the exact shape the audited code emits succeeds" \
  || bad "the audited code's findings write still fails: ${WRITE}"

QUEUE="$(psql -qtA "$DB" -c "insert into document_read_jobs (loan_file_id,document_id)
  values ('${LF}','00000000-0000-4000-8000-00000000d001') returning 1;" 2>&1 | tail -1 || true)"
[ "$QUEUE" = "1" ] && ok "a read job can be enqueued" || bad "enqueue failed: ${QUEUE}"

# Re-running the whole remediation must be safe: a half-finished production run gets retried.
echo "== the remediation is safe to re-run =="
for f in 007_finding_identity 008_security_compliance_readiness 009_document_read_queue; do
  psql -v ON_ERROR_STOP=1 -q "$DB" -f "${ROOT}/supabase/delta/${f}.sql" >/dev/null 2>&1 \
    && ok "${f} is idempotent against an already-migrated database" \
    || bad "${f} is not safe to re-run"
done
STILL="$(scalar "select count(*) from pre_underwriting_findings;")"
[ "$STILL" = "4" ] && ok "re-running changed no data" || bad "row count moved to ${STILL}, expected 4"

echo
echo "==================== ${pass} passed, ${fail} failed ===================="
[ "$fail" -eq 0 ] || exit 1
