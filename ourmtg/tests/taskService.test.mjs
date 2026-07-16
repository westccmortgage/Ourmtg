// Task state-machine + role/AI guard tests (Phase 1B §6/§12/§13).
import test from 'node:test'
import assert from 'node:assert/strict'
import { transitionTask, createTaskService, canAccessTask } from '../src/domain/services/taskService.js'

const team = { type: 'processor', id: 't1' }
const lo = { type: 'loan_officer', id: 'lo1' }
const borrower = { type: 'borrower', id: 'b1' }
const realtor = { type: 'realtor', id: 'r1' }
const ai = { type: 'ai', id: 'ai1' }
const system = { type: 'system', id: 'sys' }

const docTask = (status) => ({ id: 'task1', task_type: 'document_request', status, evidence: [] })

test('valid transition succeeds and emits history', () => {
  const r = transitionTask(docTask('created'), 'assign', team, { at: 't' })
  assert.equal(r.ok, true)
  assert.equal(r.task.status, 'assigned')
  assert.equal(r.history.from_status, 'created')
  assert.equal(r.history.to_status, 'assigned')
})

test('invalid transition rejected', () => {
  const r = transitionTask(docTask('created'), 'accept', team)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid_transition')
})

test('borrower may view/begin/submit but MAY NOT accept their own document', () => {
  assert.equal(transitionTask(docTask('assigned'), 'view', borrower).ok, true)
  assert.equal(transitionTask(docTask('in_progress'), 'submit', borrower).ok, true)
  const accept = transitionTask(docTask('team_review'), 'accept', borrower)
  assert.equal(accept.ok, false)
  assert.equal(accept.error, 'forbidden_action')
})

test('document/condition acceptance REQUIRES team_review first', () => {
  // submitted -> accepted is not in the graph at all
  assert.equal(transitionTask(docTask('submitted'), 'accept', team).error, 'invalid_transition')
  // team_review -> accepted works for team
  assert.equal(transitionTask(docTask('team_review'), 'accept', team).ok, true)
})

test('AI actor may not accept, complete, or cancel a material task', () => {
  for (const [status, action] of [['team_review', 'accept'], ['accepted', 'complete'], ['created', 'cancel']]) {
    const r = transitionTask(docTask(status), action, ai)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'ai_forbidden')
  }
})

test('realtor/escrow/title cannot access financial tasks at all', () => {
  assert.equal(canAccessTask(realtor), false)
  assert.equal(transitionTask(docTask('assigned'), 'view', realtor).error, 'forbidden_role')
  assert.equal(canAccessTask({ type: 'escrow' }), false)
  assert.equal(canAccessTask({ type: 'title' }), false)
  assert.equal(canAccessTask(borrower), true)
})

test('reopened task retains prior evidence and history', () => {
  const accepted = { id: 't', task_type: 'document_request', status: 'accepted', evidence: ['first-upload'] }
  const r = transitionTask(accepted, 'reopen', team, { evidence: 'second-note' })
  assert.equal(r.ok, true)
  assert.equal(r.task.status, 'reopened')
  assert.deepEqual(r.task.evidence, ['first-upload', 'second-note']) // prior evidence preserved
})

test('system actor is limited (assign/cancel), cannot accept', () => {
  assert.equal(transitionTask(docTask('created'), 'assign', system).ok, true)
  assert.equal(transitionTask(docTask('team_review'), 'accept', system).error, 'forbidden_action')
})

test('service persists via injected store and writes history', async () => {
  const saved = []; const history = []
  const svc = createTaskService({ store: { saveTask: (t) => saved.push(t), appendHistory: (h) => history.push(h) } })
  const created = await svc.createTask({ id: 'x', organization_id: 'org', loan_file_id: 'f', task_type: 'condition' }, lo)
  assert.equal(created.ok, true)
  assert.equal(created.task.status, 'created')
  const moved = await svc.apply(created.task, 'assign', lo, { at: 't' })
  assert.equal(moved.ok, true)
  assert.equal(saved.length, 2)
  assert.equal(history.length, 2) // created + assigned
})

test('service rejects AI creating a task and missing scope', async () => {
  const svc = createTaskService({ store: { saveTask() {}, appendHistory() {} } })
  assert.equal((await svc.createTask({ organization_id: 'o', loan_file_id: 'f' }, ai)).error, 'ai_forbidden')
  assert.equal((await svc.createTask({ loan_file_id: 'f' }, lo)).error, 'missing_scope')
})
