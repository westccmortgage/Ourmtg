// Loan-team deterministic derivations (Phase 1B §8).
import test from 'node:test'
import assert from 'node:assert/strict'
import { filesChangedSince, blockerSummary, filesNeedingBorrowerAction } from '../src/lib/loanTeamOps.js'

const now = Date.parse('2026-07-16T12:00:00Z')
const files = [
  { loanFileId: 'a', lastActivity: '2026-07-16T09:00:00Z', missingDocs: 2, pendingReview: 1, openConditions: 0, stuck: false },
  { loanFileId: 'b', lastActivity: '2026-07-10T09:00:00Z', missingDocs: 0, pendingReview: 0, openConditions: 3, stuck: true },
  { loanFileId: 'c', lastActivity: null, missingDocs: 0, pendingReview: 0, openConditions: 0, stuck: false },
]

test('filesChangedSince returns only files active within the window', () => {
  const changed = filesChangedSince(files, now)
  assert.deepEqual(changed.map((f) => f.loanFileId), ['a']) // b is 6 days old, c has no activity
})

test('blockerSummary rolls up deterministically', () => {
  const s = blockerSummary(files)
  assert.equal(s.missingDocs, 2)
  assert.equal(s.pendingReview, 1)
  assert.equal(s.openConditions, 3)
  assert.equal(s.stuck, 1)
  assert.equal(s.blockingFiles, 2) // a (missing/pending) and b (conditions/stuck)
  assert.equal(s.totalFiles, 3)
})

test('filesNeedingBorrowerAction = missing docs or open conditions', () => {
  const need = filesNeedingBorrowerAction(files)
  assert.deepEqual(need.map((f) => f.loanFileId).sort(), ['a', 'b'])
})
