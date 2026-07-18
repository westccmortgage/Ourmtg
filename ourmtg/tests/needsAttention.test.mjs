// Borrower "Needs Your Attention" derivation tests (Phase 1B §7A).
import test from 'node:test'
import assert from 'node:assert/strict'
import { borrowerActionItems, attentionCount } from '../src/lib/needsAttention.js'

const checklistItems = [
  { docKey: 'id_photo', label: 'Photo ID', status: 'accepted' },        // done → no item
  { docKey: 'paystubs_30d', label: 'Pay stubs', status: 'requested', why: 'income' }, // action
  { docKey: 'bank_2mo', label: 'Bank statements', status: 'rejected', rejectReason: 'need all pages' }, // reupload
  { docKey: 'w2_2yr', label: 'W-2s', status: 'uploaded' },              // under review → no item
]
const conditions = [
  { id: 'c1', title: 'Letter of explanation', detail: 'Explain deposit', status: 'open' },
  { id: 'c2', title: 'Gift letter', status: 'submitted' },
  { id: 'c3', title: 'Old condition', status: 'cleared' },              // cleared → no item
]

test('derives action items only for actionable docs/conditions', () => {
  const items = borrowerActionItems({ checklistItems, conditions })
  const keys = items.map((i) => i.key)
  assert.ok(keys.includes('doc:paystubs_30d'))
  assert.ok(keys.includes('doc:bank_2mo'))
  assert.ok(keys.includes('cond:c1'))
  assert.ok(keys.includes('cond:c2'))
  assert.ok(!keys.includes('doc:id_photo'))  // accepted
  assert.ok(!keys.includes('doc:w2_2yr'))    // uploaded/under review
  assert.ok(!keys.includes('cond:c3'))       // cleared
})

test('rejected doc becomes a re-upload with the reason', () => {
  const items = borrowerActionItems({ checklistItems, conditions: [] })
  const bank = items.find((i) => i.key === 'doc:bank_2mo')
  assert.match(bank.title, /Re-upload/)
  assert.match(bank.why, /all pages/)
})

test('blocking items sort first', () => {
  const items = borrowerActionItems({ checklistItems, conditions })
  assert.equal(items[0].blocking, true)
})

test('attentionCount excludes under-review (submitted) items', () => {
  const items = borrowerActionItems({ checklistItems, conditions })
  // 2 docs (blocking) + c1 (open) counted; c2 submitted excluded
  assert.equal(attentionCount(items), 3)
})

test('empty inputs → empty list', () => {
  assert.deepEqual(borrowerActionItems({}), [])
})
