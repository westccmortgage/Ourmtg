// Phase 1C — task repository tests via an INJECTED fake DB (no live Supabase). The fake models the
// AUTHORITATIVE RPC contract of migration 043 Rev 2: server-derived to-status + event type,
// optimistic-concurrency `revision` (EXT-4), request-hash idempotency with conflict (EXT-8), an
// atomic document-finalize+submit (EXT-5), and an in-transaction notification INTENT (EXT-9).
// These are FAKE-ADAPTER tests — NOT live database tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRepo, scrubTaskForBorrower } from '../netlify/functions/_lib/taskRepo.mjs'

// --- authoritative graph mirror (matches ourmtg_task_next_status / _event_type / _role_allows) ---
const FROMS = {
  assign: ['created', 'reopened'], view: ['assigned'],
  begin: ['assigned', 'viewed', 'rejected', 'more_information_needed', 'reopened'],
  submit: ['in_progress', 'more_information_needed'], precheck: ['submitted'],
  sendToTeamReview: ['submitted', 'prechecked'], accept: ['team_review'],
  reject: ['submitted', 'prechecked', 'team_review', 'rejected'],
  requestMoreInfo: ['submitted', 'prechecked', 'team_review'], complete: ['accepted'],
  reopen: ['accepted', 'completed', 'rejected'],
  cancel: ['created', 'assigned', 'viewed', 'in_progress', 'submitted', 'prechecked', 'rejected', 'more_information_needed', 'reopened'],
}
const TO = {
  assign: 'assigned', view: 'viewed', begin: 'in_progress', submit: 'submitted', precheck: 'prechecked',
  sendToTeamReview: 'team_review', accept: 'accepted', reject: 'rejected',
  requestMoreInfo: 'more_information_needed', complete: 'completed', reopen: 'reopened', cancel: 'cancelled',
}
const EVENT = {
  assign: 'task.assigned', view: 'task.viewed', begin: 'task.started', submit: 'task.submitted',
  precheck: 'task.prechecked', sendToTeamReview: 'task.team_review', accept: 'task.accepted',
  reject: 'task.rejected', requestMoreInfo: 'task.more_information_needed', complete: 'task.completed',
  reopen: 'task.reopened', cancel: 'task.cancelled',
}
const nextStatus = (from, action) => (FROMS[action]?.includes(from) ? TO[action] : null)
const roleAllows = (actorType, to) => {
  if (['loan_officer', 'processor', 'assistant'].includes(actorType)) return true
  if (['borrower', 'coborrower'].includes(actorType)) return ['viewed', 'in_progress', 'submitted'].includes(to)
  if (actorType === 'system') return ['assigned', 'cancelled'].includes(to)
  return false
}
const REVIEW_REQUIRED = ['document_request', 'document_reupload', 'condition', 'signature']

let idSeq = 0
function fakeDb({ failRpc = false } = {}) {
  const tasks = new Map()
  const documents = new Map()
  const history = []
  const events = []           // includes both domain (task.*) and intent (notification.queued) events
  // Minimal PostgREST-shaped OR clause: "col.op.val,col.op.val" (ops: eq, is null).
  function orMatch(r, clauses) {
    return clauses.some(({ col, op, val }) => {
      if (op === 'is' && val === 'null') return r[col] == null
      if (op === 'eq') {
        if (val === 'true') return r[col] === true
        if (val === 'false') return r[col] === false
        return String(r[col]) === val
      }
      return false
    })
  }
  function match(rows, filters) {
    return rows.filter((r) => filters.every(([k, v, op]) => {
      if (op === 'in') return v.includes(r[k])
      if (op === 'or') return orMatch(r, v)
      return r[k] === v
    }))
  }
  function builder(rows) {
    const filters = []
    const b = {
      select() { return b },
      eq(k, v) { filters.push([k, v, 'eq']); return b },
      in(k, v) { filters.push([k, v, 'in']); return b },
      or(expr) {
        const clauses = String(expr).split(',').map((c) => { const [col, op, ...rest] = c.split('.'); return { col, op, val: rest.join('.') } })
        filters.push(['__or__', clauses, 'or']); return b
      },
      order() { return Promise.resolve({ data: match(rows, filters), error: null }) },
      limit() { return b },
      maybeSingle() { const m = match(rows, filters); return Promise.resolve({ data: m[0] || null, error: null }) },
      then(res) { return Promise.resolve({ data: match(rows, filters), error: null }).then(res) },
    }
    return b
  }
  // Existing (org, key) event → used for idempotency lookups (both create and transition RPCs).
  function findIdem(orgId, key) {
    return events.find((e) => e.organization_id === orgId && e.idempotency_key === key)
  }
  const domainEvents = () => events.filter((e) => e.event_type !== 'notification.queued')
  const intentEvents = () => events.filter((e) => e.event_type === 'notification.queued')

  return {
    tasks, documents, history, events, domainEvents, intentEvents,
    addDoc(d) { const id = d.id || `doc-${++idSeq}`; documents.set(id, { id, status: 'requested', ...d }); return id },
    from(table) {
      if (table === 'loan_tasks') return builder([...tasks.values()])
      if (table === 'loan_documents') return builder([...documents.values()])
      if (table === 'loan_task_history') return builder(history)
      if (table === 'loan_events') return builder(events)
      return builder([])
    },
    async rpc(name, p) {
      if (failRpc) throw new Error('simulated db failure')
      // EXT-8: idempotency is MANDATORY in every RPC.
      if (!p.p_idempotency_key) return { data: null, error: { message: 'idempotency_required' } }
      // EXT-8: same (org, key) → compare request hash. Same payload → original; different → conflict.
      const existing = findIdem(p.p_organization_id, p.p_idempotency_key)
      if (existing) {
        if ((existing.request_hash ?? null) !== (p.p_request_hash ?? null)) return { data: null, error: { message: 'idempotency_conflict' } }
        const out = { ok: true, deduped: true }
        if (existing.source_record_id) out.task_id = existing.source_record_id
        return { data: out, error: null }
      }

      if (name === 'ourmtg_task_create') {
        const id = `task-${++idSeq}`
        tasks.set(id, {
          id, organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, task_type: p.p_task_type,
          title: p.p_title, borrower_explanation: p.p_borrower_explanation, internal_requirement: p.p_internal_requirement,
          responsible_party_type: p.p_responsible_party_type || 'borrower', responsible_user_id: p.p_responsible_user_id ?? null,
          shared_with_borrowers: !!p.p_shared_with_borrowers, status: 'created', revision: 0, borrower_visible_status_reason: null,
        })
        history.push({ task_id: id, from_status: null, to_status: 'created', actor_type: p.p_actor_type })
        events.push({ organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, event_type: 'task.created', idempotency_key: p.p_idempotency_key, request_hash: p.p_request_hash ?? null, source_record_id: id })
        // EXT-9: notification INTENT in the same transaction, deterministically keyed (no send).
        events.push({ organization_id: p.p_organization_id, loan_file_id: p.p_loan_file_id, event_type: 'notification.queued', idempotency_key: 'intent:' + p.p_idempotency_key, source_record_id: id, metadata: { intent: 'borrower_task_created' } })
        return { data: { ok: true, deduped: false, task_id: id }, error: null }
      }

      if (name === 'ourmtg_task_transition') {
        const t = tasks.get(p.p_task_id)
        if (!t) return { data: null, error: { message: 'task_not_found' } }
        if (t.organization_id !== p.p_organization_id) return { data: null, error: { message: 'org_mismatch' } }
        if ((t.revision ?? 0) !== p.p_expected_revision) return { data: null, error: { message: 'stale_task' } } // EXT-4
        const from = t.status
        const to = nextStatus(from, p.p_action)                       // EXT-4 server-derived
        if (!to) return { data: null, error: { message: 'invalid_transition' } }
        if (!roleAllows(p.p_actor_type, to)) return { data: null, error: { message: 'forbidden_action' } }
        if (to === 'accepted' && REVIEW_REQUIRED.includes(t.task_type) && from !== 'team_review') return { data: null, error: { message: 'review_required' } }
        // FCG-2.5: reject / more-info require a borrower-visible reason at the RPC layer.
        if ((to === 'rejected' || to === 'more_information_needed') && (p.p_borrower_visible_reason == null || String(p.p_borrower_visible_reason).trim() === '')) return { data: null, error: { message: 'reason_required' } }
        t.status = to
        t.revision = (t.revision ?? 0) + 1                            // EXT-4 bump
        if (to === 'rejected' || to === 'more_information_needed') t.borrower_visible_status_reason = p.p_borrower_visible_reason ?? null
        else if (['submitted', 'in_progress', 'accepted', 'completed'].includes(to)) t.borrower_visible_status_reason = null
        history.push({ task_id: p.p_task_id, from_status: from, to_status: to, actor_type: p.p_actor_type, reason: p.p_reason ?? null })
        events.push({ organization_id: p.p_organization_id, loan_file_id: t.loan_file_id, event_type: EVENT[p.p_action], idempotency_key: p.p_idempotency_key, request_hash: p.p_request_hash ?? null, source_record_id: p.p_task_id })
        const intent = to === 'rejected' ? 'borrower_task_rejected' : to === 'more_information_needed' ? 'borrower_task_more_information_needed' : null
        if (intent) events.push({ organization_id: p.p_organization_id, loan_file_id: t.loan_file_id, event_type: 'notification.queued', idempotency_key: 'intent:' + p.p_idempotency_key, source_record_id: p.p_task_id, metadata: { intent } })
        return { data: { ok: true, deduped: false, from, to, revision: t.revision }, error: null }
      }

      if (name === 'ourmtg_document_finalize_submit') {
        const doc = documents.get(p.p_document_id)
        if (!doc) return { data: null, error: { message: 'document_not_found' } }
        const t = tasks.get(p.p_task_id)
        if (!t) return { data: null, error: { message: 'task_not_found' } }
        if (t.organization_id !== p.p_organization_id) return { data: null, error: { message: 'org_mismatch' } }
        if (doc.loan_file_id !== t.loan_file_id) return { data: null, error: { message: 'cross_loan_document' } }
        if (!['borrower', 'coborrower'].includes(t.responsible_party_type)) return { data: null, error: { message: 'not_borrower_task' } }
        // FCG #2/#7: the acting user must be the targeted participant (or shared/untargeted).
        if (!(t.shared_with_borrowers || t.responsible_user_id == null || t.responsible_user_id === p.p_actor_user_id)) return { data: null, error: { message: 'not_participant' } }
        // FCG #3/#7: one exact document binding — a different document cannot be finalized once linked.
        if (t.linked_document_id != null && t.linked_document_id !== p.p_document_id) return { data: null, error: { message: 'document_binding_mismatch' } }
        if ((t.revision ?? 0) !== p.p_expected_revision) return { data: null, error: { message: 'stale_task' } }
        // FCG #1: the document finalize is executable from any borrower-actionable pre-submission state.
        if (!['created', 'assigned', 'viewed', 'in_progress', 'rejected', 'more_information_needed', 'reopened'].includes(t.status)) return { data: null, error: { message: 'invalid_transition' } }
        const from = t.status
        doc.status = 'uploaded'
        t.status = 'submitted'; t.revision = (t.revision ?? 0) + 1; t.linked_document_id = p.p_document_id; t.borrower_visible_status_reason = null
        history.push({ task_id: p.p_task_id, from_status: from, to_status: 'submitted', actor_type: p.p_actor_type })
        events.push({ organization_id: p.p_organization_id, loan_file_id: t.loan_file_id, event_type: 'task.submitted', idempotency_key: p.p_idempotency_key, request_hash: p.p_request_hash ?? null, source_record_id: p.p_task_id, metadata: { document_id: p.p_document_id } })
        return { data: { ok: true, deduped: false, task_id: p.p_task_id, document_id: p.p_document_id }, error: null }
      }

      return { data: null, error: { message: 'unknown_rpc' } }
    },
  }
}

const lo = { type: 'loan_officer', id: 'lo1' }
const borrower = { type: 'borrower', id: 'b1' }
const baseInput = (over = {}) => ({ organization_id: 'org', loan_file_id: 'f', title: 't', task_type: 'document_request', ...over })

// ---------------------------------------------------------------------------------------------
// Core atomicity + lifecycle
// ---------------------------------------------------------------------------------------------
test('createTask (team) writes task + history + one domain event atomically', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const r = await repo.createTask({ actor: lo, idempotencyKey: 'c1key01', input: baseInput({ title: 'Upload pay stubs' }) })
  assert.equal(r.ok, true)
  assert.equal(db.tasks.size, 1)
  assert.equal(db.history.length, 1)
  assert.equal(db.domainEvents().length, 1)   // task.created
  assert.equal(db.intentEvents().length, 1)   // EXT-9 borrower_task_created intent
})

test('valid transition persists atomically (one history + one domain event; revision bumps)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c2key01', input: baseInput() })
  const task = db.tasks.get(c.task_id)
  const r = await repo.transition({ task, action: 'assign', actor: lo, idempotencyKey: 'k-assign1', expectedRevision: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.revision, 1)                          // EXT-4
  assert.equal(db.tasks.get(c.task_id).status, 'assigned')
  assert.equal(db.history.length, 2)                   // created + assigned
  assert.equal(db.domainEvents().length, 2)            // task.created + task.assigned
})

test('invalid transition performs ZERO writes (rpc never called)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c3key01', input: baseInput() })
  const before = { h: db.history.length, e: db.events.length }
  const task = db.tasks.get(c.task_id) // status 'created'
  const r = await repo.transition({ task, action: 'accept', actor: lo, idempotencyKey: 'k-bad-001' }) // created→accepted invalid
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid_transition')
  assert.equal(db.history.length, before.h)
  assert.equal(db.events.length, before.e)
})

test('borrower cannot accept a document task (zero writes)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c4key01', input: baseInput() })
  const task = { ...db.tasks.get(c.task_id), status: 'team_review' }
  const before = db.events.length
  const r = await repo.transition({ task, action: 'accept', actor: borrower, idempotencyKey: 'k-brwr-01' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'forbidden_action')
  assert.equal(db.events.length, before)
})

test('deliberate DB failure → error and ZERO partial writes', async () => {
  const db = fakeDb({ failRpc: true }); const repo = createTaskRepo({ db })
  const r = await repo.transition({ task: { id: 'x', organization_id: 'org', loan_file_id: 'f', task_type: 'document_request', status: 'created', revision: 0, evidence: [] }, action: 'assign', actor: lo, idempotencyKey: 'k-fail-01' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'persist_failed')
  assert.equal(db.history.length, 0)
  assert.equal(db.events.length, 0)
})

test('scrubTaskForBorrower removes internal fields, keeps borrower_visible_status_reason', () => {
  const scrubbed = scrubTaskForBorrower({ id: 't', title: 'x', borrower_explanation: 'why', status: 'rejected', borrower_visible_status_reason: 'Blurry scan', internal_requirement: 'SECRET', created_by: 'lo', responsible_user_id: 'lo', metadata: { secret: 1 } })
  assert.equal(scrubbed.internal_requirement, undefined)
  assert.equal(scrubbed.created_by, undefined)
  assert.equal(scrubbed.responsible_user_id, undefined)
  assert.equal(scrubbed.metadata, undefined)
  assert.equal(scrubbed.title, 'x')
  assert.equal(scrubbed.borrower_explanation, 'why')
  assert.equal(scrubbed.borrower_visible_status_reason, 'Blurry scan') // EXT-6 surfaced
})

test('AI/partner cannot create tasks via the repo', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  assert.equal((await repo.createTask({ actor: { type: 'ai' }, idempotencyKey: 'k-ai-0001', input: baseInput() })).error, 'ai_forbidden')
  assert.equal((await repo.createTask({ actor: { type: 'realtor' }, idempotencyKey: 'k-rl-0001', input: baseInput() })).error, 'forbidden_role')
  assert.equal(db.tasks.size, 0)
})

test('AI cannot transition via the repo (zero writes)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c6key01', input: baseInput({ task_type: 'condition' }) })
  const before = db.events.length
  const r = await repo.transition({ task: { ...db.tasks.get(c.task_id), status: 'team_review' }, action: 'accept', actor: { type: 'ai' }, idempotencyKey: 'k-ai-tr01' })
  assert.equal(r.error, 'ai_forbidden')
  assert.equal(db.events.length, before)
})

// ---------------------------------------------------------------------------------------------
// EXT-8 — complete idempotency (create + transition; conflict on different payload)
// ---------------------------------------------------------------------------------------------
test('EXT-8: duplicate create, same key + same hash → one task, returns the same task_id', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const args = { actor: lo, idempotencyKey: 'dupe-create-01', requestHash: 'HASH-A', input: baseInput({ title: 'Upload W-2' }) }
  const a = await repo.createTask(args)
  const b = await repo.createTask(args)
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(b.task_id, a.task_id)
  assert.equal(db.tasks.size, 1)
})

test('EXT-8: same create key but DIFFERENT payload hash → idempotency_conflict (no second task)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  await repo.createTask({ actor: lo, idempotencyKey: 'twotab-create', requestHash: 'HASH-TITLE-1', input: baseInput({ title: 'Upload W-2' }) })
  const conflict = await repo.createTask({ actor: lo, idempotencyKey: 'twotab-create', requestHash: 'HASH-TITLE-2', input: baseInput({ title: 'Upload paystubs' }) })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error, 'idempotency_conflict')
  assert.equal(db.tasks.size, 1)
})

test('EXT-8: lost-response retry of a transition → one side effect (deduped)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c7key01', input: baseInput() })
  const snap = { ...db.tasks.get(c.task_id) }
  const a = await repo.transition({ task: { ...snap }, action: 'assign', actor: lo, idempotencyKey: 'dupe-tr-01', requestHash: 'TR-A', expectedRevision: 0 })
  const b = await repo.transition({ task: { ...snap }, action: 'assign', actor: lo, idempotencyKey: 'dupe-tr-01', requestHash: 'TR-A', expectedRevision: 0 })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(db.domainEvents().filter((e) => e.event_type === 'task.assigned').length, 1)
})

test('EXT-8: same transition key but different payload hash → idempotency_conflict', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c8key01', input: baseInput() })
  const snap = { ...db.tasks.get(c.task_id) }
  await repo.transition({ task: { ...snap }, action: 'assign', actor: lo, idempotencyKey: 'tr-conflict', requestHash: 'TR-1', expectedRevision: 0 })
  const conflict = await repo.transition({ task: { ...snap, status: 'created', revision: 0 }, action: 'cancel', actor: lo, idempotencyKey: 'tr-conflict', requestHash: 'TR-2', expectedRevision: 0 })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error, 'idempotency_conflict')
})

// ---------------------------------------------------------------------------------------------
// EXT-4 — stale-state concurrency (revision guard; stale loser writes nothing)
// ---------------------------------------------------------------------------------------------
test('EXT-4: two writers on one task — first wins, stale second is rejected with zero writes', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'c9key01', input: baseInput() })
  const snap = { ...db.tasks.get(c.task_id) } // revision 0
  const winner = await repo.transition({ task: { ...snap }, action: 'assign', actor: lo, idempotencyKey: 'race-win', expectedRevision: 0 })
  assert.equal(winner.ok, true)
  assert.equal(winner.revision, 1)
  const before = { h: db.history.length, e: db.events.length }
  // Loser used the SAME stale snapshot (still believes revision 0) with a distinct key.
  const loser = await repo.transition({ task: { ...snap }, action: 'cancel', actor: lo, idempotencyKey: 'race-lose', expectedRevision: 0 })
  assert.equal(loser.ok, false)
  assert.equal(loser.error, 'stale_task')
  assert.equal(db.history.length, before.h)  // zero writes from the stale loser
  assert.equal(db.events.length, before.e)
})

test('EXT-4: a stale reject cannot overwrite an already-accepted task', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'cAkey01', input: baseInput() })
  const id = c.task_id
  // drive to team_review then accept (real revisions)
  for (const [action, key] of [['assign', 'kA'], ['view', 'kB'], ['begin', 'kC'], ['submit', 'kD'], ['sendToTeamReview', 'kE'], ['accept', 'kF']]) {
    const cur = db.tasks.get(id)
    const r = await repo.transition({ task: cur, action, actor: action === 'submit' ? borrower : lo, idempotencyKey: key, expectedRevision: cur.revision })
    assert.equal(r.ok, true, `${action}: ${r.error || ''}`)
  }
  assert.equal(db.tasks.get(id).status, 'accepted')
  // A team member holding a STALE view (thinks it's still team_review at revision 4) tries to reject.
  const stale = await repo.transition({ task: { ...db.tasks.get(id), status: 'team_review', revision: 4 }, action: 'reject', actor: lo, borrowerVisibleReason: 'too late', idempotencyKey: 'kStale', expectedRevision: 4 })
  assert.equal(stale.ok, false)
  assert.equal(stale.error, 'stale_task')
  assert.equal(db.tasks.get(id).status, 'accepted') // unchanged
})

// ---------------------------------------------------------------------------------------------
// EXT-9 — notification intent idempotency (written in the same tx; one per event)
// ---------------------------------------------------------------------------------------------
test('EXT-9: reject writes exactly one borrower notification intent in the same transaction', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'cBkey01', input: baseInput() })
  const id = c.task_id
  for (const [action, key, who] of [['assign', 'r1', lo], ['view', 'r2', lo], ['begin', 'r3', lo], ['submit', 'r4', borrower], ['sendToTeamReview', 'r5', lo]]) {
    const cur = db.tasks.get(id)
    await repo.transition({ task: cur, action, actor: who, idempotencyKey: key, expectedRevision: cur.revision })
  }
  const cur = db.tasks.get(id)
  const r = await repo.transition({ task: cur, action: 'reject', actor: lo, borrowerVisibleReason: 'Document was blurry', idempotencyKey: 'r-reject', expectedRevision: cur.revision })
  assert.equal(r.ok, true)
  assert.equal(db.tasks.get(id).status, 'rejected')
  assert.equal(db.tasks.get(id).borrower_visible_status_reason, 'Document was blurry') // EXT-6
  const rejectIntents = db.intentEvents().filter((e) => e.metadata?.intent === 'borrower_task_rejected')
  assert.equal(rejectIntents.length, 1) // exactly one, and it lives in loan_events (same tx)
})

// ---------------------------------------------------------------------------------------------
// EXT-6 — borrower-visible reason is set on reject/more-info and CLEARED on resubmit
// ---------------------------------------------------------------------------------------------
test('EXT-6: reason set on more_information_needed, cleared when the borrower resubmits', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'cCkey01', input: baseInput() })
  const id = c.task_id
  for (const [action, key, who] of [['assign', 's1', lo], ['view', 's2', lo], ['begin', 's3', lo], ['submit', 's4', borrower]]) {
    const cur = db.tasks.get(id)
    await repo.transition({ task: cur, action, actor: who, idempotencyKey: key, expectedRevision: cur.revision })
  }
  let cur = db.tasks.get(id)
  await repo.transition({ task: cur, action: 'requestMoreInfo', actor: lo, borrowerVisibleReason: 'Need page 2', idempotencyKey: 's-moreinfo', expectedRevision: cur.revision })
  assert.equal(db.tasks.get(id).borrower_visible_status_reason, 'Need page 2')
  cur = db.tasks.get(id)
  await repo.transition({ task: cur, action: 'submit', actor: borrower, idempotencyKey: 's-resubmit', expectedRevision: cur.revision })
  assert.equal(db.tasks.get(id).status, 'submitted')
  assert.equal(db.tasks.get(id).borrower_visible_status_reason, null) // cleared on re-engagement
})

// ---------------------------------------------------------------------------------------------
// EXT-7 — participant targeting / visibility (two borrower identities on one loan)
// ---------------------------------------------------------------------------------------------
test('EXT-7: borrowerCanSeeTask — shared, targeted, untargeted, and other-borrower', () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const shared = { responsible_party_type: 'borrower', shared_with_borrowers: true, responsible_user_id: null }
  const toB1 = { responsible_party_type: 'borrower', shared_with_borrowers: false, responsible_user_id: 'b1' }
  const toB2 = { responsible_party_type: 'coborrower', shared_with_borrowers: false, responsible_user_id: 'b2' }
  const untargeted = { responsible_party_type: 'borrower', shared_with_borrowers: false, responsible_user_id: null }
  const teamOnly = { responsible_party_type: 'loan_team', shared_with_borrowers: true, responsible_user_id: null }
  assert.equal(repo.borrowerCanSeeTask(shared, 'b1'), true)
  assert.equal(repo.borrowerCanSeeTask(shared, 'b2'), true)
  assert.equal(repo.borrowerCanSeeTask(toB1, 'b1'), true)
  assert.equal(repo.borrowerCanSeeTask(toB1, 'b2'), false) // NOT visible to the other borrower
  assert.equal(repo.borrowerCanSeeTask(toB2, 'b2'), true)
  assert.equal(repo.borrowerCanSeeTask(untargeted, 'b1'), true)
  assert.equal(repo.borrowerCanSeeTask(teamOnly, 'b1'), false) // internal never borrower-visible
})

test('EXT-7: listBorrowerVisibleTasks returns only borrower tasks, scrubbed of internal fields', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  await repo.createTask({ actor: lo, idempotencyKey: 'vis-key-01', input: baseInput({ title: 'Borrower doc', responsible_party_type: 'borrower', internal_requirement: 'SECRET', shared_with_borrowers: true }) })
  await repo.createTask({ actor: lo, idempotencyKey: 'vis-key-02', input: baseInput({ title: 'Internal review', task_type: 'internal_review', responsible_party_type: 'loan_team', internal_requirement: 'SECRET2' }) })
  const visible = await repo.listBorrowerVisibleTasks('f', 'org', 'b1')
  assert.equal(visible.length, 1)
  assert.equal(visible[0].title, 'Borrower doc')
  assert.equal(visible[0].internal_requirement, undefined) // scrubbed
})

// ---------------------------------------------------------------------------------------------
// EXT-5 — atomic document finalize + task submit (roll back on any failure; fail closed)
// ---------------------------------------------------------------------------------------------
test('EXT-5: finalize marks the document uploaded, links it, and submits the task atomically', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'fin-key-01', input: baseInput({ responsible_party_type: 'borrower' }) })
  const id = c.task_id
  // move task into an in_progress state (submit is legal from there)
  for (const [action, key, who] of [['assign', 'f1', lo], ['begin', 'f2', lo]]) {
    const cur = db.tasks.get(id)
    await repo.transition({ task: cur, action, actor: who, idempotencyKey: key, expectedRevision: cur.revision })
  }
  const docId = db.addDoc({ loan_file_id: 'f', owner_user_id: 'b1' })
  const task = db.tasks.get(id)
  const r = await repo.finalizeDocumentSubmit({ documentId: docId, task, actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'finalize-ok', requestHash: 'F1' })
  assert.equal(r.ok, true)
  assert.equal(db.documents.get(docId).status, 'uploaded')
  assert.equal(db.tasks.get(id).status, 'submitted')
  assert.equal(db.tasks.get(id).linked_document_id, docId)
})

test('EXT-5: cross-loan document is rejected and NOTHING changes (doc + task untouched)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'fin-key-02', input: baseInput({ responsible_party_type: 'borrower' }) })
  const id = c.task_id
  for (const [action, key] of [['assign', 'g1'], ['begin', 'g2']]) {
    const cur = db.tasks.get(id)
    await repo.transition({ task: cur, action, actor: lo, idempotencyKey: key, expectedRevision: cur.revision })
  }
  const docId = db.addDoc({ loan_file_id: 'OTHER-FILE', owner_user_id: 'b1' }) // different loan
  const task = db.tasks.get(id)
  const beforeStatus = task.status
  const r = await repo.finalizeDocumentSubmit({ documentId: docId, task, actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'finalize-xloan', requestHash: 'F2' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'cross_loan_document')
  assert.equal(db.documents.get(docId).status, 'requested') // unchanged
  assert.equal(db.tasks.get(id).status, beforeStatus)        // unchanged
})

test('EXT-5: retry of a successful finalize finalizes exactly once (deduped, no double submit)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'fin-key-03', input: baseInput({ responsible_party_type: 'borrower' }) })
  const id = c.task_id
  for (const [action, key] of [['assign', 'h1'], ['begin', 'h2']]) {
    const cur = db.tasks.get(id)
    await repo.transition({ task: cur, action, actor: lo, idempotencyKey: key, expectedRevision: cur.revision })
  }
  const docId = db.addDoc({ loan_file_id: 'f' })
  const task = db.tasks.get(id)
  const a = await repo.finalizeDocumentSubmit({ documentId: docId, task, actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'finalize-retry', requestHash: 'F3' })
  const b = await repo.finalizeDocumentSubmit({ documentId: docId, task, actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'finalize-retry', requestHash: 'F3' })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(db.domainEvents().filter((e) => e.event_type === 'task.submitted').length, 1)
})

// helper: drive a fresh borrower document task to 'submitted'
async function driveToSubmitted(db, repo, keyPrefix) {
  const c = await repo.createTask({ actor: lo, idempotencyKey: `${keyPrefix}-c`, input: baseInput({ responsible_party_type: 'borrower' }) })
  const id = c.task_id
  for (const [action, who] of [['assign', lo], ['view', lo], ['begin', lo], ['submit', borrower]]) {
    const cur = db.tasks.get(id)
    await repo.transition({ task: cur, action, actor: who, idempotencyKey: `${keyPrefix}-${action}`, expectedRevision: cur.revision })
  }
  return id
}

// ---------------------------------------------------------------------------------------------
// FCG-2.5 / FCG-11.8 — a reject without a borrower-visible reason cannot complete (zero writes)
// ---------------------------------------------------------------------------------------------
test('FCG-2.5: reject with no borrower-visible reason is rejected (reason_required, zero writes)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const id = await driveToSubmitted(db, repo, 'rr')
  const before = { h: db.history.length, e: db.events.length, status: db.tasks.get(id).status }
  const cur = db.tasks.get(id)
  const r = await repo.transition({ task: cur, action: 'reject', actor: lo, idempotencyKey: 'reject-noreason', expectedRevision: cur.revision }) // no borrowerVisibleReason
  assert.equal(r.ok, false)
  assert.equal(r.error, 'reason_required')
  assert.equal(db.tasks.get(id).status, before.status) // unchanged
  assert.equal(db.history.length, before.h)            // zero writes
  assert.equal(db.events.length, before.e)
})

test('FCG-12.3: reject WITH a reason succeeds and preserves the reason', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const id = await driveToSubmitted(db, repo, 'rok')
  const cur = db.tasks.get(id)
  const r = await repo.transition({ task: cur, action: 'reject', actor: lo, borrowerVisibleReason: 'Statement is unreadable', idempotencyKey: 'reject-ok', expectedRevision: cur.revision })
  assert.equal(r.ok, true)
  assert.equal(db.tasks.get(id).status, 'rejected')
  assert.equal(db.tasks.get(id).borrower_visible_status_reason, 'Statement is unreadable')
})

// ---------------------------------------------------------------------------------------------
// FCG-11.22 — a repeated (idempotent) reject does not create a duplicate notification intent
// ---------------------------------------------------------------------------------------------
test('FCG-11.22: repeated reject with the same key produces exactly one notification intent', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const id = await driveToSubmitted(db, repo, 'dup')
  // Genuine double-submit: both requests are built from the SAME pre-reject snapshot ('submitted').
  const snap = { ...db.tasks.get(id) }
  const first = await repo.transition({ task: { ...snap }, action: 'reject', actor: lo, borrowerVisibleReason: 'Blurry', idempotencyKey: 'reject-dup', requestHash: 'RJ', expectedRevision: snap.revision })
  const retry = await repo.transition({ task: { ...snap }, action: 'reject', actor: lo, borrowerVisibleReason: 'Blurry', idempotencyKey: 'reject-dup', requestHash: 'RJ', expectedRevision: snap.revision })
  assert.equal(first.deduped, false)
  assert.equal(retry.deduped, true)
  assert.equal(db.intentEvents().filter((e) => e.metadata?.intent === 'borrower_task_rejected').length, 1)
})

// ---------------------------------------------------------------------------------------------
// FCG-2.8 / FCG-11.9 / FCG-11.20 — cross-organization mutation is impossible at the RPC contract
// ---------------------------------------------------------------------------------------------
test('FCG-2.8: the transition RPC rejects a cross-organization mutation (org_mismatch)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'xorg-c', input: baseInput() }) // org 'org'
  const before = { h: db.history.length, e: db.events.length }
  const { error } = await db.rpc('ourmtg_task_transition', {
    p_task_id: c.task_id, p_action: 'assign', p_expected_revision: 0, p_actor_type: 'loan_officer',
    p_actor_id: 'lo1', p_organization_id: 'OTHER-ORG', p_idempotency_key: 'xorg-tr', p_request_hash: 'X',
  })
  assert.equal(error.message, 'org_mismatch')
  assert.equal(db.history.length, before.h) // zero writes
  assert.equal(db.events.length, before.e)
})

test('FCG-11.20: the finalize RPC rejects a cross-organization document/task link (org_mismatch)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'xorg-fc', input: baseInput({ responsible_party_type: 'borrower' }) })
  const docId = db.addDoc({ loan_file_id: 'f' })
  const { error } = await db.rpc('ourmtg_document_finalize_submit', {
    p_document_id: docId, p_task_id: c.task_id, p_organization_id: 'OTHER-ORG', p_actor_user_id: 'b1',
    p_actor_type: 'borrower', p_expected_revision: 0, p_idempotency_key: 'xorg-fin', p_request_hash: 'X',
  })
  assert.equal(error.message, 'org_mismatch')
  assert.equal(db.documents.get(docId).status, 'requested') // unchanged
})

// ---------------------------------------------------------------------------------------------
// FCG clarification #1 — the borrower task lifecycle is executable end to end via the document finalize
// ---------------------------------------------------------------------------------------------
test('FCG #1: create → assign → view → begin → linked finalize → submitted (end to end)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'e2e-create', input: baseInput({ responsible_party_type: 'borrower', shared_with_borrowers: true }) })
  const id = c.task_id
  for (const action of ['assign', 'view', 'begin']) {
    const cur = db.tasks.get(id)
    const r = await repo.transition({ task: cur, action, actor: lo, idempotencyKey: `e2e-${action}`, expectedRevision: cur.revision })
    assert.equal(r.ok, true, `${action}: ${r.error || ''}`)
  }
  assert.equal(db.tasks.get(id).status, 'in_progress')
  const docId = db.addDoc({ loan_file_id: 'f' })
  const fin = await repo.finalizeDocumentSubmit({ documentId: docId, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'e2e-fin', requestHash: 'E2E' })
  assert.equal(fin.ok, true)
  assert.equal(db.tasks.get(id).status, 'submitted')
  assert.equal(db.documents.get(docId).status, 'uploaded')
  assert.equal(db.tasks.get(id).linked_document_id, docId)
})

test('FCG #1: a borrower can finalize directly from a freshly created (unassigned) task', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'fresh-c', input: baseInput({ responsible_party_type: 'borrower', shared_with_borrowers: true }) })
  const id = c.task_id
  const docId = db.addDoc({ loan_file_id: 'f' })
  const r = await repo.finalizeDocumentSubmit({ documentId: docId, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'fresh-fin', requestHash: 'F' })
  assert.equal(r.ok, true)
  assert.equal(db.tasks.get(id).status, 'submitted')
})

test('FCG #1: finalize from a terminal (completed) state is rejected (invalid_transition, nothing changes)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'term-c', input: baseInput({ responsible_party_type: 'borrower', shared_with_borrowers: true }) })
  const id = c.task_id
  db.tasks.get(id).status = 'completed'
  const docId = db.addDoc({ loan_file_id: 'f' })
  const r = await repo.finalizeDocumentSubmit({ documentId: docId, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'term-fin', requestHash: 'T' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid_transition')
  assert.equal(db.documents.get(docId).status, 'requested')
})

// ---------------------------------------------------------------------------------------------
// FCG clarification #2/#7 — participant targeting is enforced at the finalize RPC
// ---------------------------------------------------------------------------------------------
test('FCG #2/#7: a borrower cannot finalize a task targeted at ANOTHER borrower (not_participant)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'tgt-c', input: baseInput({ responsible_party_type: 'borrower', responsible_user_id: 'b1', shared_with_borrowers: false }) })
  const id = c.task_id
  const docId = db.addDoc({ loan_file_id: 'f' })
  const wrong = await repo.finalizeDocumentSubmit({ documentId: docId, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b2' }, idempotencyKey: 'tgt-b2', requestHash: 'B2' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error, 'not_participant')
  assert.equal(db.documents.get(docId).status, 'requested') // untouched
  // the targeted borrower succeeds
  const right = await repo.finalizeDocumentSubmit({ documentId: docId, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'tgt-b1', requestHash: 'B1' })
  assert.equal(right.ok, true)
  assert.equal(db.tasks.get(id).status, 'submitted')
})

// ---------------------------------------------------------------------------------------------
// FCG clarification #3/#7 — a document task binds to ONE exact document
// ---------------------------------------------------------------------------------------------
test('FCG #3/#7: once bound, finalizing a DIFFERENT document is rejected (document_binding_mismatch)', async () => {
  const db = fakeDb(); const repo = createTaskRepo({ db })
  const c = await repo.createTask({ actor: lo, idempotencyKey: 'bind-c', input: baseInput({ responsible_party_type: 'borrower', shared_with_borrowers: true }) })
  const id = c.task_id
  const docA = db.addDoc({ loan_file_id: 'f' })
  const docB = db.addDoc({ loan_file_id: 'f' })
  db.tasks.get(id).linked_document_id = docA // already bound to docA
  const mismatch = await repo.finalizeDocumentSubmit({ documentId: docB, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'bind-b', requestHash: 'BB' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.error, 'document_binding_mismatch')
  // finalizing the SAME bound document is allowed
  const ok = await repo.finalizeDocumentSubmit({ documentId: docA, task: db.tasks.get(id), actor: { type: 'borrower', id: 'b1' }, idempotencyKey: 'bind-a', requestHash: 'BA' })
  assert.equal(ok.ok, true)
  assert.equal(db.tasks.get(id).status, 'submitted')
})
