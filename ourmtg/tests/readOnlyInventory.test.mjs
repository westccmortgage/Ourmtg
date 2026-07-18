import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(
  new URL('../supabase/inventory/001_privileged_read_only.sql', import.meta.url),
  'utf8',
)

test('privileged inventory is explicitly read-only and contains no write statements', () => {
  const executable = sql.replace(/^\s*--.*$/gm, '')
  assert.match(executable, /begin transaction read only;/i)
  assert.match(executable, /current_setting\('transaction_read_only'\)/i)
  assert.doesNotMatch(
    executable,
    /\b(create|alter|drop|insert|update|delete|truncate|grant|revoke)\s+/i,
  )
})

test('privileged inventory covers security metadata without selecting borrower contents', () => {
  for (const source of [
    'pg_catalog.pg_policies',
    'pg_catalog.pg_constraint',
    'pg_catalog.pg_indexes',
    'information_schema.triggers',
    'information_schema.role_table_grants',
    'storage.buckets',
  ]) {
    assert.match(sql, new RegExp(source.replace('.', '\\.')))
  }
  assert.doesNotMatch(sql, /select\s+\*\s+from\s+public\./i)
})

test('privileged inventory returns one exportable JSON result', () => {
  assert.match(sql, /select jsonb_build_object\([\s\S]*\) as inventory/i)
  for (const section of [
    'tables_and_rls',
    'experimental_tables',
    'columns',
    'row_counts',
    'policies',
    'constraints',
    'indexes',
    'triggers',
    'storage_buckets',
    'table_privileges',
  ]) {
    assert.match(sql, new RegExp(`'${section}'`))
  }
})
