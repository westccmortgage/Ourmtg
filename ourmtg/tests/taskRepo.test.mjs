// Phase 1C — task repository tests via an INJECTED fake DB (no live Supabase). Proves atomic
// persistence, idempotency, validation-before-write, borrower field-scoping, and zero partial
// writes on failure. The fake `rpc` models the atomic transaction (all-or-nothing).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRepo, scrubTaskForBorrower } from '../netlify/functions/_lib/taskRepo.mjs'

let idSeq = 0
function fakeDb({ failRpc = false } = {}) {
  const tasks = new Map()
  const history = []
  const events = []
  const idem = new Set()
  function match(rows, filters) {
    return rows.filter((r) => filters.every(([k, v, op]) => op === 'in' ? v.includes(r[k]) : r[k] === v))
  }
  function builder(rows) {
    const filters = []
    const b = {
      select() { return b },
      eq(k, v) { filters.push([k, v, 'eq']); return b },
      in(k, v) { filters.push([k, v, 'in']); return b },
      order() { return Promise.resolve({ data: match(rows, filters), error: null }) },
      limit() { return b },
      maybeSingle() { const m = match(rows, filters); return Promise.resolve({ data: m[0] || null, error: null }) },
      then(res) { return Promise.resolve({ data: match(rows, filters), error: null }).then(res) },
    }
    return b
  }
  return {
    tasks, history, events, idem,
    from(table) {
      if (table === 'loan_tasks') return builder([...tasks.values()])
      if (table === 'loan_task_history') return builder(history)
      if (table === 'loan_events') return builder(events)
      return builder([])
    },
    async rpc(name, p) {
      if (failRpc) throw new Error('simulated db failure')
      const key = p.p_idempotency_key ? `${p.p_organization_id}:${p.p_idempotency_key}` : null
      if (key && idem.has(key)) return { data: { ok: true, deduped: true }, error: null }
      if (name === 'ourmtg_task_create') {
        const id = `task-${++idSeq}`
        tasks.set(id, { id, organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, task_type: p.p_task_type, title: p.p_title, borrower_explanation: p.p_borrower_explanation, internal_requirement: p.p_internal_requirement, responsible_party_type: p.p_responsible_party_type, status: 'created' })
        history.push({ task_id: id, from_status: null, to_status: 'created', actor_type: p.p_actor_type })
        events.push({ organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, event_type: 'task.created', idempotency_key: p.p_idempotency_key })
        if (key) idem.add(key)
        return { data: { ok: true, deduped: false, task_id: id }, error: null }
      }
      if (name === 'ourmtg_task_transition') {
        const t = tasks.get(p.p_task_id)
        if (!t) return { data: null, error: { message: 'task_not_found' } }
        const from = t.status
        t.status = p.p_to_status
        history.push({ task_id: p.p_task_id, from_status: from, to_status: p.p_to_status, actor_type: p.p_actor_type })
        events.push({ organization_id: p.p_organization_id, loan_file_id: t.loan_file_id, event_type: p.p_event_type, idempotency_key: p.p_idempotency_key })
        if (key) idem.add(key)
        return { data: { ok: true, deduped: false, from, to: p.p_to_status }, error: null }
      }
      return { data: null, error: { message: 'unknown_rpc' } }
    },
  }
}

const lo = { type: 'loan_officer', id: 'lo1' }
const borrower = { type: 'borrower', id: 'b1' }

test('createTask (team) writes task + history + event atomically', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const r = await repo.createTask({ actor: lo, idempotencyKey: 'c1', input: { organization_id: 'org', loan_file_id: 'f', title: 'Upload pay stubs', task_type: 'document_request' } })
  assert.equal(r.ok, true)
  assert.equal(db.tasks.size, 1)
  assert.equal(db.history.length, 1)
  assert.equal(db.events.length, 1)
})

test('valid transition persists atomically (one history + one event)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c2', input: { organization_id: 'org', loan_file_id: 'f', title: 't', task_type: 'document_request' } })
  const task = db.tasks.get(c.task_id)
  const r = await repo.transition({ task, action: 'assign', actor: lo, idempotencyKey: 'k-assign' })
  assert.equal(r.ok, true)
  assert.equal(db.tasks.get(c.task_id).status, 'assigned')
  assert.equal(db.history.length, 2)  // created + assigned
  assert.equal(db.events.length, 2)
})

test('invalid transition performs ZERO writes (rpc never called)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c3', input: { organization_id: 'org', loan_file_id: 'f', title: 't', task_type: 'document_request' } })
  const before = { h: db.history.length, e: db.events.length }
  const task = db.tasks.get(c.task_id) // status 'created'
  const r = await repo.transition({ task, action: 'accept', actor: lo }) // created→accepted invalid
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid_transition')
  assert.equal(db.history.length, before.h) // zero new writes
  assert.equal(db.events.length, before.e)
})

test('borrower cannot accept a document task (zero writes)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c4', input: { organization_id: 'org', loan_file_id: 'f', title: 't', task_type: 'document_request' } })
  const task = { ...db.tasks.get(c.task_id), status: 'team_review' }
  const before = db.events.length
  const r = await repo.transition({ task, action: 'accept', actor: borrower })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'forbidden_action')
  assert.equal(db.events.length, before)
})

test('idempotent transition: duplicate key → one side effect', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c5', input: { organization_id: 'org', loan_file_id: 'f', title: 't', task_type: 'document_request' } })
  // Genuine double-submit: both requests load the SAME pre-state snapshot ('created') and send
  // the same idempotency key. The atomic RPC dedupes the second.
  const snap = { ...db.tasks.get(c.task_id) }
  const a = await repo.transition({ task: { ...snap }, action: 'assign', actor: lo, idempotencyKey: 'dupe' })
  const b = await repo.transition({ task: { ...snap }, action: 'assign', actor: lo, idempotencyKey: 'dupe' })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(db.events.filter((e) => e.event_type === 'task.assigned').length, 1)
})

test('deliberate DB failure → error and ZERO partial writes', async () => {
  const db = fakeDb({ failRpc: true }); const repo = createTaskRepo({ db })
  const r = await repo.transition({ task: { id: 'x', organization_id: 'org', loan_file_id: 'f', task_type: 'document_request', status: 'created', evidence: [] }, action: 'assign', actor: lo })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'persist_failed')
  assert.equal(db.history.length, 0)
  assert.equal(db.events.length, 0)
})

test('scrubTaskForBorrower removes internal fields', () => {
  const scrubbed = scrubTaskForBorrower({ id: 't', title: 'x', borrower_explanation: 'why', status: 'assigned', internal_requirement: 'SECRET', created_by: 'lo', responsible_user_id: 'lo', metadata: { secret: 1 } })
  assert.equal(scrubbed.internal_requirement, undefined)
  assert.equal(scrubbed.created_by, undefined)
  assert.equal(scrubbed.responsible_user_id, undefined)
  assert.equal(scrubbed.metadata, undefined)
  assert.equal(scrubbed.title, 'x')
  assert.equal(scrubbed.borrower_explanation, 'why')
})

test('AI/partner cannot create tasks via the repo', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  assert.equal((await repo.createTask({ actor: { type: 'ai' }, input: { organization_id: 'o', loan_file_id: 'f', title: 't' } })).error, 'ai_forbidden')
  assert.equal((await repo.createTask({ actor: { type: 'realtor' }, input: { organization_id: 'o', loan_file_id: 'f', title: 't' } })).error, 'forbidden_role')
  assert.equal(db.tasks.size, 0)
})

test('AI cannot transition via the repo (zero writes)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c6', input: { organization_id: 'org', loan_file_id: 'f', title: 't', task_type: 'condition' } })
  const before = db.events.length
  const r = await repo.transition({ task: { ...db.tasks.get(c.task_id), status: 'team_review' }, action: 'accept', actor: { type: 'ai' } })
  assert.equal(r.error, 'ai_forbidden')
  assert.equal(db.events.length, before)
})

test('listBorrowerVisibleTasks returns only borrower tasks, scrubbed of internal fields', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  await repo.createTask({ actor: lo, idempotencyKey: 'v1', input: { organization_id: 'org', loan_file_id: 'f', title: 'Borrower doc', task_type: 'document_request', responsible_party_type: 'borrower', internal_requirement: 'SECRET' } })
  await repo.createTask({ actor: lo, idempotencyKey: 'v2', input: { organization_id: 'org', loan_file_id: 'f', title: 'Internal review', task_type: 'internal_review', responsible_party_type: 'loan_team', internal_requirement: 'SECRET2' } })
  const visible = await repo.listBorrowerVisibleTasks('f', 'org')
  assert.equal(visible.length, 1)                       // only the borrower task
  assert.equal(visible[0].title, 'Borrower doc')
  assert.equal(visible[0].internal_requirement, undefined) // scrubbed
})
