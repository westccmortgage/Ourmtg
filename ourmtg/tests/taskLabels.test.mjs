// Phase 1C — trilingual task label tests (§10 EN/ES/RU).
import test from 'node:test'
import assert from 'node:assert/strict'
import { taskStatusLabel, taskActionLabel, blocksLabel, borrowerMustAct } from '../src/lib/taskLabels.js'

test('every borrower-visible status has EN/ES/RU labels', () => {
  for (const s of ['created', 'assigned', 'viewed', 'in_progress', 'submitted', 'accepted', 'rejected', 'more_information_needed', 'completed', 'reopened', 'cancelled']) {
    for (const lang of ['en', 'es', 'ru']) {
      const label = taskStatusLabel(s, lang)
      assert.ok(typeof label === 'string' && label.length > 0 && label !== s, `${s}/${lang}`)
    }
  }
})

test('internal review states show a borrower-safe "under review" in all langs', () => {
  for (const s of ['submitted', 'prechecked', 'team_review']) {
    assert.equal(taskStatusLabel(s, 'en'), 'Under review')
    assert.ok(taskStatusLabel(s, 'ru').length > 0)
  }
})

test('actions + blocks label localized; fallback to EN for unknown lang', () => {
  assert.equal(taskActionLabel('upload', 'es'), 'Subir')
  assert.equal(taskActionLabel('upload', 'zz'), 'Upload') // fallback
  assert.ok(blocksLabel('ru').length > 0)
})

test('borrowerMustAct flags action states, not review/done', () => {
  assert.equal(borrowerMustAct('rejected'), true)
  assert.equal(borrowerMustAct('assigned'), true)
  assert.equal(borrowerMustAct('submitted'), false)
  assert.equal(borrowerMustAct('completed'), false)
})
