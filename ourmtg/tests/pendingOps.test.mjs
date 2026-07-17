import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrCreatePendingOperation, readPendingOperation, settlePendingOperation,
  pendingOperationStorageKey,
} from '../src/lib/pendingOps.js'

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    has: (k) => m.has(k),
  }
}

test('same material reuses one idempotency key across calls and refresh reads', () => {
  const s = memoryStorage()
  const a = getOrCreatePendingOperation('create:f1', { title: 'W-2' }, s)
  const b = getOrCreatePendingOperation('create:f1', { title: 'W-2' }, s)
  const restored = readPendingOperation('create:f1', s)
  assert.equal(a.idempotencyKey, b.idempotencyKey)
  assert.equal(restored.idempotencyKey, a.idempotencyKey)
})

test('ambiguous timeout preserves pending operation; definitive response clears it', () => {
  const s = memoryStorage()
  const op = getOrCreatePendingOperation('transition:t1:view', { expectedRevision: 1 }, s)
  settlePendingOperation('transition:t1:view', op, { status: 0 }, s)
  assert.ok(readPendingOperation('transition:t1:view', s))
  settlePendingOperation('transition:t1:view', op, null, s)
  assert.equal(readPendingOperation('transition:t1:view', s), null)
})

test('reuseExisting preserves original expected revision after an ambiguous response', () => {
  const s = memoryStorage()
  const first = getOrCreatePendingOperation('transition:t1:view', { expectedRevision: 1 }, s)
  const retry = getOrCreatePendingOperation('transition:t1:view', { expectedRevision: 2 }, s, { reuseExisting: true })
  assert.equal(retry.idempotencyKey, first.idempotencyKey)
  assert.equal(retry.material.expectedRevision, 1)
  assert.equal(s.has(pendingOperationStorageKey('transition:t1:view')), true)
})
