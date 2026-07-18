// Append-only event service tests (Phase 1B §5).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventService } from '../src/domain/services/eventService.js'

function memStore() {
  const rows = []
  return {
    rows,
    async append(e) { rows.push(e); return e },
    async findByIdempotencyKey(org, key) { return rows.find((r) => r.organization_id === org && r.idempotency_key === key) || null },
  }
}
const base = { organization_id: 'org1', loan_file_id: 'file1', event_type: 'task.created', actor_type: 'loan_officer', source_system: 'ourmtg' }

test('appends a valid event', async () => {
  const store = memStore()
  const svc = createEventService({ store })
  const r = await svc.appendEvent(base)
  assert.equal(r.ok, true)
  assert.equal(store.rows.length, 1)
})

test('requires organization_id and loan_file_id', async () => {
  const svc = createEventService({ store: memStore() })
  assert.equal((await svc.appendEvent({ ...base, organization_id: undefined })).error, 'missing_organization_id')
  assert.equal((await svc.appendEvent({ ...base, loan_file_id: undefined })).error, 'missing_loan_file_id')
})

test('rejects invalid event type and actor and missing source', async () => {
  const svc = createEventService({ store: memStore() })
  assert.equal((await svc.appendEvent({ ...base, event_type: 'not.real' })).error, 'invalid_event_type')
  assert.equal((await svc.appendEvent({ ...base, actor_type: 'wizard' })).error, 'invalid_actor')
  assert.equal((await svc.appendEvent({ ...base, source_system: undefined })).error, 'missing_source_system')
})

test('idempotency key dedupes side effects (no second insert)', async () => {
  const store = memStore()
  const svc = createEventService({ store })
  const a = await svc.appendEvent({ ...base, idempotency_key: 'k1' })
  const b = await svc.appendEvent({ ...base, idempotency_key: 'k1' })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(store.rows.length, 1) // only one row
})

test('appended events are immutable (frozen)', async () => {
  const svc = createEventService({ store: memStore() })
  const r = await svc.appendEvent(base)
  assert.throws(() => { r.event.event_type = 'tampered' }, TypeError)
})
