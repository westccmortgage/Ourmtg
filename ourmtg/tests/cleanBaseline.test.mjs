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
  'statement_income_analyses',
  'statement_income_months',
  'site_settings',
]

test('clean baseline contains every table used by the first browser workflow', () => {
  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`, 'i'), table)
  }
})

test('clean baseline matches the live GRCRM projection shape', () => {
  assert.match(sql, /borrower_name\s+text\s*,/i)
  assert.doesNotMatch(sql, /borrower_name\s+text\s+not null/i)
  assert.match(sql, /loan_documents_file\s+on public\.loan_documents \(loan_file_id\)/i)
  assert.match(sql, /check \(amount is null or amount >= 0\)/i)
  assert.match(sql, /check \(preapproval_amount is null or preapproval_amount >= 0\)/i)
})

test('clean baseline keeps the GRCRM heartbeat explicitly optional', () => {
  assert.match(sql, /Operational visibility for the optional GRCRM projector/i)
  assert.match(sql, /create table if not exists public\.cron_heartbeat\b/i)
})

test('clean baseline keeps the document bucket private', () => {
  assert.match(sql, /'ourmtg-docs',\s*'ourmtg-docs',\s*false,\s*26214400/i)
  assert.doesNotMatch(sql, /'ourmtg-docs',\s*'ourmtg-docs',\s*true/i)
  for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif']) {
    assert.match(sql, new RegExp(`'${mime}'`))
  }
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
  assert.match(sql, /revoke all privileges on table public\.loan_strategy from anon, authenticated/i)
})

test('statement income data is server-only and human-reviewed', () => {
  const section = sql.slice(
    sql.indexOf('create table if not exists public.statement_income_analyses'),
    sql.indexOf('create table if not exists public.site_settings'),
  )
  assert.match(sql, /create table if not exists public\.statement_income_analyses/i)
  assert.match(sql, /status in \('needs_review','reviewed','superseded'\)/i)
  assert.match(sql, /borrower_visible\s+boolean not null default false/i)
  assert.match(sql, /revoke all privileges on table public\.statement_income_analyses from anon, authenticated/i)
  assert.match(sql, /revoke all privileges on table public\.statement_income_months from anon, authenticated/i)
  assert.doesNotMatch(section, /create policy/i)
})

test('manual loan-file creation is platform-admin gated in the handler', () => {
  const handler = readFileSync(new URL('../netlify/functions/portal-loanfile-set.mjs', import.meta.url), 'utf8')
  assert.match(handler, /isPlatformAdmin\(auth\.user\.email,\s*process\.env\.OURMTG_ADMIN_EMAILS\)/)
  assert.match(handler, /Not authorized to create loan files/)
})
