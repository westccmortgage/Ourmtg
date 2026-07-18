// Phase 1C repository tests through an injected in-memory adapter.
// These are NOT live Supabase tests. The fake mirrors the final review-only migration contract:
// create+assign, canonical transitions, exact document binding, participant scoping, revision
// concurrency, material-result idempotency and atomic task/history/event/intent writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRepo, scrubTaskForBorrower } from '../netlify/functions/_lib/taskRepo.mjs'

const FROMS = {
  assign: ['created', 'reopened'],
  view: ['assigned'],
  begin: ['assigned', 'viewed', 'rejected', 'more_information_needed', 'reopened'],
  submit: ['in_progress', 'more_information_needed'],
  precheck: ['submitted'],
  sendToTeamReview: ['submitted', 'prechecked'],
  accept: ['team_review'],
  reject: ['submitted', 'prechecked', 'team_review'],
  requestMoreInfo: ['submitted', 'prechecked', 'team_review'],
  complete: ['accepted'],
  reopen: ['accepted', 'completed', 'rejected'],
  cancel: ['created', 'assigned', 'viewed', 'in_progress', 'submitted', 'prechecked', 'rejected', 'more_information_needed', 'reopened'],
}
const TO = {
  assign: 'assigned', view: 'viewed', begin: 'in_progress', submit: 'submitted',
  precheck: 'prechecked', sendToTeamReview: 'team_review', accept: 'accepted',
  reject: 'rejected', requestMoreInfo: 'more_information_needed', complete: 'completed',
  reopen: 'reopened', cancel: 'cancelled',
}
const EVENT = {
  assign: 'task.assigned', view: 'task.viewed', begin: 'task.started', submit: 'task.submitted',
  precheck: 'task.prechecked', sendToTeamReview: 'task.team_review', accept: 'task.accepted',
  reject: 'task.rejected', requestMoreInfo: 'task.more_information_needed', complete: 'task.completed',
  reopen: 'task.reopened', cancel: 'task.cancelled',
}
const nextStatus = (from, action) => FROMS[action]?.includes(from) ? TO[action] : null
const roleAllows = (actor, to) => {
  if (['loan_officer', 'processor', 'assistant'].includes(actor)) return true
  if (['borrower', 'coborrower'].includes(actor)) return ['viewed', 'in_progress', 'submitted'].includes(to)
  if (actor === 'system') return ['assigned', 'cancelled'].includes(to)
  return false
}

const lo = { type: 'loan_officer', id: 'lo1' }
const borrower = { type: 'borrower', id: 'b1' }
const coborrower = { type: 'coborrower', id: 'b2' }

function fakeDb({ failRpc = false, failFinalize = false } = {}) {
  let seq = 0
  const loanFiles = new Map([
    ['f1', { id: 'f1', organization_id: 'org1', owner_user_id: 'lo1' }],
    ['f2', { id: 'f2', organization_id: 'org2', owner_user_id: 'lo2' }],
  ])
  const members = new Set(['org1:lo1', 'org2:lo2'])
  const participants = new Map([
    ['f1:b1', 'borrower'], ['f1:b2', 'coborrower'], ['f2:b3', 'borrower'],
  ])
  const documents = new Map([
    ['d1', { id: 'd1', loan_file_id: 'f1', who: 'borrower', status: 'requested' }],
    ['d2', { id: 'd2', loan_file_id: 'f1', who: 'coborrower', status: 'requested' }],
    ['d3', { id: 'd3', loan_file_id: 'f2', who: 'borrower', status: 'requested' }],
  ])
  const tasks = new Map()
  const history = []
  const events = []

  const domainEvents = () => events.filter((e) => e.event_type !== 'notification.queued')
  const intentEvents = () => events.filter((e) => e.event_type === 'notification.queued')
  const idem = (org, key) => events.find((e) => e.organization_id === org && e.idempotency_key === key)

  function rowsFor(table) {
    if (table === 'loan_tasks') return [...tasks.values()]
    if (table === 'loan_task_history') return history
    if (table === 'loan_events') return events
    if (table === 'loan_documents') return [...documents.values()]
    return []
  }
  function builder(rows) {
    const filters = []
    const apply = () => rows.filter((row) => filters.every((f) => {
      if (f.kind === 'eq') return row[f.key] === f.value
      if (f.kind === 'in') return f.value.includes(row[f.key])
      if (f.kind === 'or') return f.value.some(({ key, op, value }) => {
        if (op === 'eq') return value === 'true' ? row[key] === true : String(row[key]) === value
        if (op === 'is') return value === 'null' ? row[key] == null : false
        return false
      })
      return true
    }))
    const q = {
      select() { return q },
      eq(key, value) { filters.push({ kind: 'eq', key, value }); return q },
      in(key, value) { filters.push({ kind: 'in', key, value }); return q },
      or(expr) {
        const clauses = String(expr).split(',').map((part) => {
          const [key, op, ...rest] = part.split('.')
          return { key, op, value: rest.join('.') }
        })
        filters.push({ kind: 'or', value: clauses }); return q
      },
      order() { return Promise.resolve({ data: apply(), error: null }) },
      maybeSingle() { return Promise.resolve({ data: apply()[0] || null, error: null }) },
      then(resolve) { return Promise.resolve({ data: apply(), error: null }).then(resolve) },
    }
    return q
  }

  function duplicateResult(existing) {
    return {
      ok: true,
      deduped: true,
      task_id: existing.source_record_id,
      status: existing.result?.status,
      from: existing.result?.from,
      to: existing.result?.to,
      revision: existing.result?.revision,
      document_id: existing.result?.document_id,
    }
  }

  async function rpc(name, p) {
    if (failRpc) throw new Error('simulated transport failure')
    if (!p.p_idempotency_key || !p.p_request_hash) return { data: null, error: { message: 'idempotency_required' } }
    const existing = idem(p.p_organization_id, p.p_idempotency_key)
    if (existing) {
      if (existing.request_hash !== p.p_request_hash) return { data: null, error: { message: 'idempotency_conflict' } }
      return { data: duplicateResult(existing), error: null }
    }

    if (name === 'ourmtg_task_create') {
      const loan = loanFiles.get(p.p_loan_file_id)
      if (!loan || loan.organization_id !== p.p_organization_id) return { data: null, error: { message: 'loan_org_mismatch' } }
      if (!members.has(`${p.p_organization_id}:${p.p_actor_id}`)) return { data: null, error: { message: 'forbidden_action' } }

      let party = 'borrower'
      if (p.p_shared_with_borrowers) {
        if (p.p_responsible_user_id != null) return { data: null, error: { message: 'audience_invalid' } }
        if (![...participants.keys()].some((k) => k.startsWith(`${p.p_loan_file_id}:`))) return { data: null, error: { message: 'participant_invalid' } }
      } else {
        if (!p.p_responsible_user_id) return { data: null, error: { message: 'audience_invalid' } }
        party = participants.get(`${p.p_loan_file_id}:${p.p_responsible_user_id}`)
        if (!party) return { data: null, error: { message: 'participant_invalid' } }
      }

      const documentTask = ['document_request', 'document_reupload', 'missing_page'].includes(p.p_task_type)
      const doc = p.p_required_document_id ? documents.get(p.p_required_document_id) : null
      if (documentTask && !doc) return { data: null, error: { message: 'required_document_missing' } }
      if (doc && doc.loan_file_id !== p.p_loan_file_id) return { data: null, error: { message: 'document_binding_mismatch' } }
      if (doc && !p.p_shared_with_borrowers && doc.who !== party) return { data: null, error: { message: 'participant_invalid' } }

      const id = `task-${++seq}`
      const task = {
        id, organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id,
        task_type: p.p_task_type, title: p.p_title,
        borrower_explanation: p.p_borrower_explanation,
        internal_requirement: p.p_internal_requirement,
        responsible_party_type: party,
        responsible_user_id: p.p_responsible_user_id ?? null,
        shared_with_borrowers: !!p.p_shared_with_borrowers,
        required_document_id: p.p_required_document_id ?? null,
        linked_document_id: null,
        borrower_visible_status_reason: null,
        status: 'assigned', revision: 1,
      }
      tasks.set(id, task)
      history.push(
        { task_id: id, from_status: null, to_status: 'created', actor_type: p.p_actor_type },
        { task_id: id, from_status: 'created', to_status: 'assigned', actor_type: p.p_actor_type },
      )
      const result = { status: 'assigned', revision: 1 }
      events.push(
        { organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, event_type: 'task.created', idempotency_key: p.p_idempotency_key, request_hash: p.p_request_hash, source_record_id: id, result },
        { organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, event_type: 'task.assigned', idempotency_key: `assign:${p.p_idempotency_key}`, request_hash: p.p_request_hash, source_record_id: id },
        { organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, event_type: 'notification.queued', idempotency_key: `intent:${p.p_idempotency_key}`, source_record_id: id, metadata: { intent: 'borrower_task_created' } },
      )
      return { data: { ok: true, deduped: false, task_id: id, ...result }, error: null }
    }

    if (name === 'ourmtg_task_transition') {
      const task = tasks.get(p.p_task_id)
      if (!task) return { data: null, error: { message: 'task_not_found' } }
      const loan = loanFiles.get(task.loan_file_id)
      if (task.organization_id !== p.p_organization_id || loan?.organization_id !== p.p_organization_id) return { data: null, error: { message: 'loan_org_mismatch' } }
      if (task.revision !== p.p_expected_revision) return { data: null, error: { message: 'stale_task' } }
      const from = task.status
      const to = nextStatus(from, p.p_action)
      if (!to) return { data: null, error: { message: 'invalid_transition' } }
      if (!roleAllows(p.p_actor_type, to)) return { data: null, error: { message: 'forbidden_action' } }
      if (['loan_officer', 'processor', 'assistant'].includes(p.p_actor_type) && !members.has(`${p.p_organization_id}:${p.p_actor_id}`)) return { data: null, error: { message: 'forbidden_action' } }
      if (['borrower', 'coborrower'].includes(p.p_actor_type)) {
        if (participants.get(`${task.loan_file_id}:${p.p_actor_id}`) !== p.p_actor_type) return { data: null, error: { message: 'not_participant' } }
        if (!(task.shared_with_borrowers || task.responsible_user_id === p.p_actor_id)) return { data: null, error: { message: 'not_participant' } }
      }
      if (['reject', 'requestMoreInfo', 'reopen'].includes(p.p_action) && !String(p.p_borrower_visible_reason || '').trim()) return { data: null, error: { message: 'reason_required' } }

      const revision = task.revision + 1
      task.status = to; task.revision = revision
      if (['reject', 'requestMoreInfo', 'reopen'].includes(p.p_action)) task.borrower_visible_status_reason = p.p_borrower_visible_reason
      else if (['in_progress', 'submitted', 'accepted', 'completed'].includes(to)) task.borrower_visible_status_reason = null
      history.push({ task_id: task.id, from_status: from, to_status: to, actor_type: p.p_actor_type, reason: p.p_reason ?? null })
      const result = { from, to, revision }
      events.push({ organization_id: task.organization_id, loan_file_id: task.loan_file_id, event_type: EVENT[p.p_action], idempotency_key: p.p_idempotency_key, request_hash: p.p_request_hash, source_record_id: task.id, result })
      const intent = p.p_action === 'reject' ? 'borrower_task_rejected' : p.p_action === 'requestMoreInfo' ? 'borrower_task_more_information_needed' : p.p_action === 'reopen' ? 'borrower_task_reopened' : null
      if (intent) events.push({ organization_id: task.organization_id, loan_file_id: task.loan_file_id, event_type: 'notification.queued', idempotency_key: `intent:${p.p_idempotency_key}`, source_record_id: task.id, metadata: { intent } })
      return { data: { ok: true, deduped: false, task_id: task.id, ...result }, error: null }
    }

    if (name === 'ourmtg_document_finalize_submit') {
      if (failFinalize) return { data: null, error: { message: 'simulated_finalize_failure' } }
      const task = tasks.get(p.p_task_id)
      const doc = documents.get(p.p_document_id)
      if (!task) return { data: null, error: { message: 'task_not_found' } }
      if (!doc) return { data: null, error: { message: 'document_not_found' } }
      const loan = loanFiles.get(task.loan_file_id)
      if (task.organization_id !== p.p_organization_id || loan?.organization_id !== p.p_organization_id) return { data: null, error: { message: 'loan_org_mismatch' } }
      if (doc.loan_file_id !== task.loan_file_id) return { data: null, error: { message: 'cross_loan_document' } }
      if (task.required_document_id !== doc.id) return { data: null, error: { message: 'document_binding_mismatch' } }
      if (task.revision !== p.p_expected_revision) return { data: null, error: { message: 'stale_task' } }
      if (task.status !== 'in_progress') return { data: null, error: { message: 'invalid_transition' } }
      const visibility = participants.get(`${task.loan_file_id}:${p.p_actor_user_id}`)
      if (!visibility || visibility !== p.p_actor_type) return { data: null, error: { message: 'not_participant' } }
      if (!(task.shared_with_borrowers || (task.responsible_user_id === p.p_actor_user_id && task.responsible_party_type === visibility))) return { data: null, error: { message: 'not_participant' } }

      const revision = task.revision + 1
      doc.status = 'uploaded'
      task.status = 'submitted'; task.revision = revision; task.linked_document_id = doc.id; task.borrower_visible_status_reason = null
      history.push({ task_id: task.id, from_status: 'in_progress', to_status: 'submitted', actor_type: p.p_actor_type })
      const result = { to: 'submitted', revision, document_id: doc.id }
      events.push(
        { organization_id: task.organization_id, loan_file_id: task.loan_file_id, event_type: 'task.submitted', idempotency_key: p.p_idempotency_key, request_hash: p.p_request_hash, source_record_id: task.id, result },
        { organization_id: task.organization_id, loan_file_id: task.loan_file_id, event_type: 'notification.queued', idempotency_key: `intent:${p.p_idempotency_key}`, source_record_id: task.id, metadata: { intent: 'borrower_document_submitted' } },
      )
      return { data: { ok: true, deduped: false, task_id: task.id, document_id: doc.id, to: 'submitted', revision }, error: null }
    }

    return { data: null, error: { message: 'unknown_rpc' } }
  }

  return {
    loanFiles, participants, documents, tasks, history, events,
    domainEvents, intentEvents,
    from(table) { return builder(rowsFor(table)) },
    rpc,
  }
}

const baseInput = (over = {}) => ({
  organization_id: 'org1', loan_file_id: 'f1', title: 'Upload bank statement',
  task_type: 'document_request', responsible_user_id: 'b1', shared_with_borrowers: false,
  required_document_id: 'd1', ...over,
})
const createArgs = (db, over = {}) => createTaskRepo({ db }).createTask({
  actor: lo, idempotencyKey: 'create-op-0001', requestHash: 'create-hash', input: baseInput(), ...over,
})

async function beginBorrowerTask(db, repo, taskId, actor = borrower) {
  let task = db.tasks.get(taskId)
  let r = await repo.transition({ task: { ...task }, action: 'view', actor, expectedRevision: task.revision, idempotencyKey: `view-${taskId}`, requestHash: `view-h-${taskId}` })
  assert.equal(r.ok, true)
  task = db.tasks.get(taskId)
  r = await repo.transition({ task: { ...task }, action: 'begin', actor, expectedRevision: task.revision, idempotencyKey: `begin-${taskId}`, requestHash: `begin-h-${taskId}` })
  assert.equal(r.ok, true)
  return db.tasks.get(taskId)
}

test('create is atomic created+assigned with one intent and exact binding', async () => {
  const db = fakeDb(); const result = await createArgs(db)
  assert.equal(result.ok, true); assert.equal(result.status, 'assigned'); assert.equal(result.revision, 1)
  const task = db.tasks.get(result.task_id)
  assert.equal(task.required_document_id, 'd1')
  assert.deepEqual(db.history.map((h) => h.to_status), ['created', 'assigned'])
  assert.deepEqual(db.domainEvents().map((e) => e.event_type), ['task.created', 'task.assigned'])
  assert.equal(db.intentEvents().length, 1)
})

test('create retry returns the original task/status/revision; payload drift conflicts', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const args = { actor: lo, idempotencyKey: 'same-create-key', requestHash: 'same-hash', input: baseInput() }
  const first = await repo.createTask(args); const retry = await repo.createTask(args)
  assert.equal(retry.deduped, true); assert.equal(retry.task_id, first.task_id)
  assert.equal(retry.status, 'assigned'); assert.equal(retry.revision, 1)
  const conflict = await repo.createTask({ ...args, requestHash: 'different-hash' })
  assert.equal(conflict.error, 'idempotency_conflict'); assert.equal(db.tasks.size, 1)
})

test('specific borrower, co-borrower and shared audiences are enforced', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const primary = await repo.createTask({ actor: lo, idempotencyKey: 'aud-primary', requestHash: 'h1', input: baseInput() })
  const co = await repo.createTask({ actor: lo, idempotencyKey: 'aud-co', requestHash: 'h2', input: baseInput({ responsible_user_id: 'b2', required_document_id: 'd2' }) })
  const shared = await repo.createTask({ actor: lo, idempotencyKey: 'aud-shared', requestHash: 'h3', input: baseInput({ responsible_user_id: null, shared_with_borrowers: true }) })
  assert.equal(db.tasks.get(primary.task_id).responsible_party_type, 'borrower')
  assert.equal(db.tasks.get(co.task_id).responsible_party_type, 'coborrower')
  assert.equal(repo.borrowerCanSeeTask(db.tasks.get(primary.task_id), 'b2'), false)
  assert.equal(repo.borrowerCanSeeTask(db.tasks.get(co.task_id), 'b1'), false)
  assert.equal(repo.borrowerCanSeeTask(db.tasks.get(shared.task_id), 'b1'), true)
  assert.equal(repo.borrowerCanSeeTask(db.tasks.get(shared.task_id), 'b2'), true)
})

test('arbitrary participant and wrong-file document are rejected with zero writes', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  let r = await repo.createTask({ actor: lo, idempotencyKey: 'bad-participant', requestHash: 'bp', input: baseInput({ responsible_user_id: 'stranger' }) })
  assert.equal(r.error, 'participant_invalid')
  r = await repo.createTask({ actor: lo, idempotencyKey: 'bad-document', requestHash: 'bd', input: baseInput({ required_document_id: 'd3' }) })
  assert.equal(r.error, 'document_binding_mismatch')
  assert.equal(db.tasks.size, 0); assert.equal(db.events.length, 0)
})

test('borrower lifecycle is assigned → viewed → in_progress → finalize → submitted', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db }); const created = await createArgs(db)
  const ready = await beginBorrowerTask(db, repo, created.task_id)
  assert.equal(ready.status, 'in_progress'); assert.equal(ready.revision, 3)
  const result = await repo.finalizeDocumentSubmit({ documentId: 'd1', task: { ...ready }, actor: borrower, expectedRevision: ready.revision, idempotencyKey: 'finalize-1', requestHash: 'finalize-h1' })
  assert.equal(result.ok, true); assert.equal(result.to, 'submitted'); assert.equal(result.revision, 4)
  assert.equal(db.documents.get('d1').status, 'uploaded')
  assert.equal(db.tasks.get(created.task_id).linked_document_id, 'd1')
})

test('finalize cannot skip lifecycle and wrong document/participant creates zero writes', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db }); const created = await createArgs(db)
  let task = db.tasks.get(created.task_id)
  let r = await repo.finalizeDocumentSubmit({ documentId: 'd1', task: { ...task }, actor: borrower, expectedRevision: task.revision, idempotencyKey: 'skip-finalize', requestHash: 'skip' })
  assert.equal(r.error, 'invalid_transition'); assert.equal(db.documents.get('d1').status, 'requested')
  task = await beginBorrowerTask(db, repo, created.task_id)
  const before = { h: db.history.length, e: db.events.length }
  r = await repo.finalizeDocumentSubmit({ documentId: 'd2', task: { ...task }, actor: borrower, expectedRevision: task.revision, idempotencyKey: 'wrong-doc-finalize', requestHash: 'wrong-doc' })
  assert.equal(r.error, 'document_binding_mismatch')
  r = await repo.finalizeDocumentSubmit({ documentId: 'd1', task: { ...task }, actor: coborrower, expectedRevision: task.revision, idempotencyKey: 'wrong-user-finalize', requestHash: 'wrong-user' })
  assert.equal(r.error, 'not_participant')
  assert.deepEqual({ h: db.history.length, e: db.events.length }, before)
})

test('finalize retry returns original task/document/revision and creates one intent', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db }); const created = await createArgs(db)
  const task = await beginBorrowerTask(db, repo, created.task_id)
  const args = { documentId: 'd1', task: { ...task }, actor: borrower, expectedRevision: task.revision, idempotencyKey: 'finalize-retry', requestHash: 'fin-hash' }
  const first = await repo.finalizeDocumentSubmit(args); const retry = await repo.finalizeDocumentSubmit(args)
  assert.equal(retry.deduped, true); assert.equal(retry.task_id, first.task_id)
  assert.equal(retry.document_id, 'd1'); assert.equal(retry.to, 'submitted'); assert.equal(retry.revision, 4)
  assert.equal(db.domainEvents().filter((e) => e.event_type === 'task.submitted').length, 1)
  assert.equal(db.intentEvents().filter((e) => e.metadata?.intent === 'borrower_document_submitted').length, 1)
})

test('invalid/stale transition and transport failure leave zero partial writes', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db }); const created = await createArgs(db)
  let task = db.tasks.get(created.task_id)
  const before = { h: db.history.length, e: db.events.length }
  let r = await repo.transition({ task: { ...task }, action: 'accept', actor: lo, expectedRevision: task.revision, idempotencyKey: 'invalid-transition', requestHash: 'invalid-h' })
  assert.equal(r.error, 'invalid_transition'); assert.deepEqual({ h: db.history.length, e: db.events.length }, before)
  const snap = { ...task }
  r = await repo.transition({ task: { ...snap }, action: 'view', actor: borrower, expectedRevision: snap.revision, idempotencyKey: 'view-winner', requestHash: 'vw' })
  assert.equal(r.ok, true)
  const staleBefore = { h: db.history.length, e: db.events.length }
  r = await repo.transition({ task: { ...snap }, action: 'begin', actor: borrower, expectedRevision: snap.revision, idempotencyKey: 'stale-loser', requestHash: 'sl' })
  assert.equal(r.error, 'stale_task'); assert.deepEqual({ h: db.history.length, e: db.events.length }, staleBefore)

  const failed = createTaskRepo({ db: fakeDb({ failRpc: true }) })
  r = await failed.transition({ task: { ...snap }, action: 'view', actor: borrower, expectedRevision: snap.revision, idempotencyKey: 'transport-fail', requestHash: 'tf' })
  assert.equal(r.error, 'persist_failed')
})

test('reject, more-info and reopen require and preserve borrower-visible reasons', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db }); const created = await createArgs(db)
  let task = await beginBorrowerTask(db, repo, created.task_id)
  let r = await repo.transition({ task: { ...task }, action: 'submit', actor: borrower, expectedRevision: task.revision, idempotencyKey: 'submit-manual', requestHash: 'sm' })
  assert.equal(r.ok, true)
  task = db.tasks.get(created.task_id)
  r = await repo.transition({ task: { ...task }, action: 'requestMoreInfo', actor: lo, expectedRevision: task.revision, idempotencyKey: 'more-no-reason', requestHash: 'mnr' })
  assert.equal(r.error, 'reason_required')
  r = await repo.transition({ task: { ...task }, action: 'requestMoreInfo', actor: lo, borrowerVisibleReason: 'Please include page 6', expectedRevision: task.revision, idempotencyKey: 'more-reason', requestHash: 'mr' })
  assert.equal(r.ok, true); assert.equal(db.tasks.get(created.task_id).borrower_visible_status_reason, 'Please include page 6')
  task = db.tasks.get(created.task_id)
  r = await repo.transition({ task: { ...task }, action: 'begin', actor: borrower, expectedRevision: task.revision, idempotencyKey: 'begin-correction', requestHash: 'bc' })
  assert.equal(r.ok, true); assert.equal(db.tasks.get(created.task_id).borrower_visible_status_reason, null)
})

test('duplicate transition returns original material result and one intent', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db }); const created = await createArgs(db)
  let task = await beginBorrowerTask(db, repo, created.task_id)
  await repo.transition({ task: { ...task }, action: 'submit', actor: borrower, expectedRevision: task.revision, idempotencyKey: 'submit-for-reject', requestHash: 'sfr' })
  task = db.tasks.get(created.task_id)
  const args = { task: { ...task }, action: 'reject', actor: lo, borrowerVisibleReason: 'Unreadable image', expectedRevision: task.revision, idempotencyKey: 'reject-retry', requestHash: 'reject-hash' }
  const first = await repo.transition(args); const retry = await repo.transition(args)
  assert.equal(retry.deduped, true); assert.equal(retry.from, first.from); assert.equal(retry.to, first.to); assert.equal(retry.revision, first.revision)
  assert.equal(db.intentEvents().filter((e) => e.metadata?.intent === 'borrower_task_rejected').length, 1)
})

test('borrower listing and scrubbing enforce participant and internal-field boundaries', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  await repo.createTask({ actor: lo, idempotencyKey: 'list-primary', requestHash: 'lp', input: baseInput() })
  await repo.createTask({ actor: lo, idempotencyKey: 'list-co', requestHash: 'lc', input: baseInput({ responsible_user_id: 'b2', required_document_id: 'd2' }) })
  await repo.createTask({ actor: lo, idempotencyKey: 'list-shared', requestHash: 'ls', input: baseInput({ responsible_user_id: null, shared_with_borrowers: true }) })
  const primary = await repo.listBorrowerVisibleTasks('f1', 'org1', 'b1')
  const co = await repo.listBorrowerVisibleTasks('f1', 'org1', 'b2')
  assert.equal(primary.length, 2); assert.equal(co.length, 2)
  for (const row of primary) {
    assert.equal(row.internal_requirement, undefined)
    assert.equal(row.responsible_user_id, undefined)
    assert.equal(row.metadata, undefined)
    assert.equal(typeof row.revision, 'number')
  }
})

test('AI and partner roles cannot create or mutate authoritative tasks', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  assert.equal((await repo.createTask({ actor: { type: 'ai' }, idempotencyKey: 'ai-create', requestHash: 'ai', input: baseInput() })).error, 'ai_forbidden')
  assert.equal((await repo.createTask({ actor: { type: 'realtor' }, idempotencyKey: 'r-create', requestHash: 'r', input: baseInput() })).error, 'forbidden_role')
  const created = await createArgs(db)
  const task = db.tasks.get(created.task_id)
  assert.equal((await repo.transition({ task, action: 'view', actor: { type: 'ai' }, expectedRevision: task.revision, idempotencyKey: 'ai-view', requestHash: 'aiv' })).error, 'ai_forbidden')
})
