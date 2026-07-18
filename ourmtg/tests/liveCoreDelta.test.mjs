import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(
  new URL('../supabase/delta/001_live_core_hardening.sql', import.meta.url),
  'utf8',
)

test('live delta is pinned to the primary project and fails closed on wrong projects', () => {
  assert.match(sql, /diqukqhbmqcheffhensp/)
  assert.match(sql, /to_regclass\('public\.' \|\| required_table\)/i)
  assert.match(sql, /private ourmtg-docs bucket is missing/i)
})

test('live delta closes raw strategy browser access', () => {
  assert.match(sql, /drop policy if exists "portal read approved strategy"/i)
  assert.match(sql, /revoke all privileges on table public\.loan_strategy from anon, authenticated/i)
})

test('live delta adds guarded non-negative amount constraints', () => {
  assert.match(sql, /where amount < 0 or preapproval_amount < 0/i)
  assert.match(sql, /loan_files_amount_check check \(amount is null or amount >= 0\)/i)
  assert.match(sql, /loan_files_preapproval_amount_check check \(preapproval_amount is null or preapproval_amount >= 0\)/i)
})

test('live delta hardens the existing private document bucket', () => {
  assert.match(sql, /file_size_limit = 26214400/i)
  assert.match(sql, /public = false/i)
  for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif']) {
    assert.match(sql, new RegExp(`'${mime}'`))
  }
})

test('live delta excludes abandoned workflow expansion', () => {
  assert.doesNotMatch(sql, /create\s+table/i)
  assert.doesNotMatch(sql, /organizations|organization_members|loan_tasks|loan_task_history/i)
  assert.doesNotMatch(sql, /cron_heartbeat/i)
})
