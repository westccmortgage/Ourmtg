import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const delta = read('../supabase/delta/002_statement_income_analysis.sql')
const createHandler = read('../netlify/functions/portal-statement-analysis-create.mjs')
const setHandler = read('../netlify/functions/portal-statement-analysis-set.mjs')
const getHandler = read('../netlify/functions/portal-statement-analysis.mjs')

test('statement delta is pinned, guarded, RLS-enabled, and browser-dark', () => {
  assert.match(delta, /diqukqhbmqcheffhensp/)
  assert.match(delta, /Wrong or incomplete project/)
  assert.match(delta, /alter table public\.statement_income_analyses enable row level security/i)
  assert.match(delta, /alter table public\.statement_income_months enable row level security/i)
  assert.match(delta, /revoke all privileges on table public\.statement_income_analyses from anon, authenticated/i)
  assert.match(delta, /revoke all privileges on table public\.statement_income_months from anon, authenticated/i)
  assert.doesNotMatch(delta, /create policy/i)
})

test('automatic extraction remains an internal suggestion', () => {
  assert.match(createHandler, /isInternal\(access\)/)
  assert.match(createHandler, /needs_review:\s*true/)
  assert.match(createHandler, /extractPdfStatementSummaries/)
  assert.doesNotMatch(createHandler, /preapproval_amount|portal-preapproval-set/)
})

test('human review is required before borrower visibility', () => {
  assert.match(setHandler, /action === 'save'/)
  assert.match(setHandler, /status:\s*'reviewed'/)
  assert.match(setHandler, /reviewed_by:\s*auth\.user\.id/)
  assert.match(setHandler, /borrower_visible:\s*true/)
  assert.match(setHandler, /does NOT set loan_files\.preapproval/i)
  assert.doesNotMatch(setHandler, /preapproval_amount|portal-preapproval-set/)
  assert.match(getHandler, /eq\('status', 'reviewed'\)\.eq\('borrower_visible', true\)/)
})
