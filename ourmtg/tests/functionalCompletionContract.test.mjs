import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8')

test('migration creates+assigns tasks and preserves both transitions', async () => {
  const sql = await read('docs/phase1c/migration/043_ourmtg_operational_pilot.sql')
  assert.match(sql, /'assigned',1/)
  assert.match(sql, /values \(v_task_id,null,'created'/)
  assert.match(sql, /\(v_task_id,'created','assigned'/)
  assert.match(sql, /'task\.assigned'/)
})

test('migration finalize requires in_progress and exact required document', async () => {
  const sql = await read('docs/phase1c/migration/043_ourmtg_operational_pilot.sql')
  assert.match(sql, /v_task\.required_document_id is distinct from p_document_id/)
  assert.match(sql, /v_task\.status<>'in_progress'/)
  assert.doesNotMatch(sql, /status not in \('created','assigned','viewed'/)
})

test('database and JS graphs do not allow rejected to reject again', async () => {
  const [sql, js] = await Promise.all([
    read('docs/phase1c/migration/043_ourmtg_operational_pilot.sql'),
    read('netlify/functions/_lib/taskLifecycle.mjs'),
  ])
  assert.doesNotMatch(sql, /p_action='reject'[^\n]*'rejected'\)/)
  assert.match(js, /rejected: \['in_progress', 'reopened', 'cancelled'\]/)
})

test('task-linked finalize is request-guarded and intent-only', async () => {
  const src = await read('netlify/functions/portal-doc-complete.mjs')
  assert.match(src, /readJsonBody\(req\)/)
  assert.match(src, /if \(route\.mode === 'legacy'\)/)
  assert.match(src, /task-linked Phase 1C is intent-only/i)
})

test('team UI requires exact document and verified audience', async () => {
  const src = await read('src/components/TeamTaskCard.jsx')
  assert.match(src, /requiredDocumentId/)
  assert.match(src, /Borrower audience/)
  assert.match(src, /teamActionsForTask/)
  assert.match(src, /getOrCreatePendingOperation/)
})

test('borrower document page renders only the bound request and prepares lifecycle', async () => {
  const src = await read('src/pages/Documents.jsx')
  assert.match(src, /i\.documentId === task\.required_document_id/)
  assert.match(src, /borrowerPreparationActions/)
  assert.match(src, /expectedRevision/)
})
