import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../supabase/baseline/001_ourmtg_core.sql', import.meta.url), 'utf8')

const requiredTables = [
  'loan_files',
  'portal_users',
  'portal_access',
  'portal_team',
  'portal_invites',
  'loan_documents',
  'loan_conditions',
  'loan_messages',
  'portal_consent',
  'portal_access_log',
  'site_settings',
  'cron_heartbeat',
]

test('clean baseline contains every table used by the first browser workflow', () => {
  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`, 'i'), table)
  }
})

test('clean baseline keeps the document bucket private', () => {
  assert.match(sql, /values\s*\('ourmtg-docs',\s*'ourmtg-docs',\s*false\)/i)
  assert.doesNotMatch(sql, /values\s*\('ourmtg-docs',\s*'ourmtg-docs',\s*true\)/i)
})

test('clean baseline excludes the abandoned Phase 1C migration machinery', () => {
  for (const name of ['organizations', 'organization_members', 'loan_tasks', 'loan_task_history']) {
    assert.doesNotMatch(sql, new RegExp(`create table if not exists public\\.${name}\\b`, 'i'), name)
  }
  assert.doesNotMatch(sql, /ourmtg_task_create|ourmtg_task_transition|backfill_refused|rollback rehearsal/i)
})

test('clean baseline has final portal roles and no raw strategy browser policy', () => {
  for (const role of ['borrower', 'coborrower', 'realtor', 'escrow', 'title']) {
    assert.match(sql, new RegExp(`'${role}'`), role)
  }
  assert.match(sql, /drop policy if exists "portal read approved strategy"/i)
  assert.doesNotMatch(sql, /create policy "portal read approved strategy"/i)
})

test('manual loan-file creation is platform-admin gated in the handler', () => {
  const handler = readFileSync(new URL('../netlify/functions/portal-loanfile-set.mjs', import.meta.url), 'utf8')
  assert.match(handler, /isPlatformAdmin\(auth\.user\.email,\s*process\.env\.OURMTG_ADMIN_EMAILS\)/)
  assert.match(handler, /Not authorized to create loan files/)
})
