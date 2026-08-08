import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../src/features/conversational-1003/pages/ApplicationAssistant.jsx', import.meta.url),
  'utf8',
)

test('the guided 1003 keeps one latest-turn receipt instead of accumulating a chat transcript', () => {
  assert.match(source, /const \[receipt, setReceipt\] = useState\(null\)/)
  assert.doesNotMatch(source, /role: ['"]borrower['"]|c1003-msg--borrower|setThread\(/)
  assert.doesNotMatch(source, /role: ['"]assistant['"], question:/)
})

test('a material confirmation is the active step and blocks the next question', () => {
  assert.match(source, /question && !receipt\?\.confirmation && !addressCheck && <ActiveQuestion/)
  assert.match(source, /!receipt\?\.confirmation && !addressCheck && question\?\.type !== ['"]review['"]/)
  assert.match(source, /setReceipt\(null\)[\s\S]*nextQuestion: res\.nextQuestion/)
})

test('a lost mobile response is reconciled with the same idempotent turn', () => {
  assert.match(source, /if \(firstError\?\.status !== 0\) throw firstError/)
  assert.match(source, /res = await sendTurn\(payload\)[\s\S]*res = await sendTurn\(payload\)/)
  assert.match(source, /idempotencyKey: pendingKey\.current/)
})

test('property-address verification blocks the next question until corrected or accepted', () => {
  assert.match(source, /PROPERTY_ADDRESS_PATHS/)
  assert.match(source, /validatePropertyAddress/)
  assert.match(source, /acceptPropertyAddress/)
  assert.match(source, /!receipt\?\.confirmation && !addressCheck && <ActiveQuestion/)
})
