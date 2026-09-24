// The read queue's concurrency guarantees, exercised directly.
//
// These are the properties the follow-up loop rests on, and every one of them is only
// observable under a race. The journey test proves the happy path; this file proves the
// unhappy ones, by driving the queue functions against the fake database in the exact order a
// bad minute would produce.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase } from './_fakeSupabase.mjs'
import { createClient } from '@supabase/supabase-js'
import {
  enqueueRead, listQueued, claim, finish, requeueStale, readStateForFile,
  CLAIM_TTL_MS, MAX_ATTEMPTS,
} from '../netlify/functions/_lib/readQueue.mjs'

const LOAN = { id: '44444444-4444-4444-8444-444444444444', organization_id: 'org-1' }
const DOC = { id: '55555555-5555-4555-8555-555555555501' }
const DOC2 = { id: '55555555-5555-4555-8555-555555555502' }

function db() {
  const fake = createFakeSupabase({
    tables: {
      document_read_jobs: [],
      loan_files: [{ id: LOAN.id, organization_id: 'org-1' }],
      loan_documents: [{ id: DOC.id, loan_file_id: LOAN.id }, { id: DOC2.id, loan_file_id: LOAN.id }],
    },
  })
  const svc = createClient('https://fake.supabase.co', 'service-role-key', {
    auth: { persistSession: false },
    global: { fetch: fake.fetch },
  })
  return { fake, svc }
}

const rows = (fake) => fake.rowsOf('document_read_jobs')
const only = (fake) => {
  const r = rows(fake)
  assert.equal(r.length, 1, `expected one job, found ${r.length}`)
  return r[0]
}

test('a job starts with no attempts and a bounded ceiling, written explicitly', () => {
  // Not left to the column defaults: a storage layer that did not apply them would make
  // `attempts + 1` NaN and the retry bound meaningless.
  const { fake, svc } = db()
  return enqueueRead(svc, { loanFile: LOAN, document: DOC }).then((out) => {
    assert.equal(out.ok, true)
    const job = only(fake)
    assert.equal(job.status, 'queued')
    assert.equal(job.attempts, 0)
    assert.equal(job.max_attempts, MAX_ATTEMPTS)
    assert.equal(job.requested_by, 'borrower_upload')
    assert.ok(job.correlation_id, 'a job carries its own correlation id')
  })
})

test('the same document cannot be queued twice while one is live', async () => {
  const { fake, svc } = db()
  const first = await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const second = await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  assert.equal(first.ok, true)
  // The second is a SUCCESS: a read is owed, which is what the caller wanted to be true.
  assert.equal(second.ok, true)
  assert.equal(second.deduped, true)
  assert.equal(rows(fake).length, 1, 'the same PDF would have been read — and billed — twice')
})

test('two workers racing for one job: exactly one wins', async () => {
  const { fake, svc } = db()
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const [candidate] = await listQueued(svc)

  // Both workers saw the same queued row — which is exactly what listQueued does not prevent.
  const a = await claim(svc, candidate)
  const b = await claim(svc, candidate)

  assert.ok(a, 'the first worker must get it')
  assert.equal(b, null, 'the second worker must be told it lost')
  assert.equal(only(fake).attempts, 1, 'a lost race must not burn an attempt')
})

test('a stalled worker cannot overwrite the job that was taken from it', async () => {
  // THE RACE THIS GUARDS. Worker A claims a job and stalls past the claim TTL. requeueStale
  // hands the job back. Worker B claims it and starts reading. Worker A finally returns and
  // writes `done`. Without the status guard, B's in-flight read is marked finished by A, the
  // document is read and billed twice, and the queue reports a completion that has not happened.
  const { fake, svc } = db()
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const [candidate] = await listQueued(svc)

  const t0 = Date.parse('2026-09-20T10:00:00Z')
  const jobA = await claim(svc, candidate, { now: t0 })
  assert.ok(jobA)

  // …eleven minutes pass with no word from A.
  const later = t0 + CLAIM_TTL_MS + 60_000
  const requeued = await requeueStale(svc, { now: later })
  assert.equal(requeued, 1)
  assert.equal(only(fake).status, 'queued')

  const [again] = await listQueued(svc)
  const jobB = await claim(svc, again, { now: later })
  assert.ok(jobB, 'worker B takes the job')
  assert.equal(only(fake).attempts, 2)

  // A wakes up and tries to report success on a job it no longer owns.
  const late = await finish(svc, jobA, { status: 'done', now: later + 1000 })
  assert.equal(late.ok, false)
  assert.equal(late.lost, true, 'A must learn it lost the job')
  assert.equal(only(fake).status, 'running', 'B is still working; the row must say so')

  // B reports, and that write lands.
  const good = await finish(svc, jobB, { status: 'done', now: later + 2000 })
  assert.equal(good.ok, true)
  assert.equal(only(fake).status, 'done')
})

test('a job that keeps failing stops, rather than consuming a slot forever', async () => {
  const { fake, svc } = db()
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })

  let now = Date.parse('2026-09-20T10:00:00Z')
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const [candidate] = await listQueued(svc)
    assert.ok(candidate, `attempt ${attempt} should still be queued`)
    const job = await claim(svc, candidate, { now })
    assert.ok(job, `attempt ${attempt} should be claimable`)
    assert.equal(job.attempts, attempt)
    await finish(svc, job, { status: 'queued', code: 'read_failed', error: 'provider timeout', now })
    now += 1000
  }

  // The fourth look retires it instead of claiming it.
  const [last] = await listQueued(svc)
  assert.ok(last)
  assert.equal(last.attempts, MAX_ATTEMPTS)
  assert.equal(await claim(svc, last, { now }), null)

  const job = only(fake)
  assert.equal(job.status, 'failed')
  assert.equal(job.last_error_code, 'attempts_exhausted')
  assert.ok(job.finished_at, 'a retired job records when it was given up on')
  assert.deepEqual(await listQueued(svc), [], 'a dead job must leave the queue')
})

test('a failure reason is recorded, and bounded', async () => {
  const { fake, svc } = db()
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const [c] = await listQueued(svc)
  const job = await claim(svc, c)
  await finish(svc, job, { status: 'failed', code: 'refusal', error: 'x'.repeat(5000) })
  const row = only(fake)
  assert.equal(row.last_error_code, 'refusal')
  assert.equal(row.last_error.length, 500, 'an operator-facing string must not grow without bound')
})

test('finishing a document frees it to be read again after a re-upload', async () => {
  const { fake, svc } = db()
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const [c] = await listQueued(svc)
  await finish(svc, await claim(svc, c), { status: 'done' })

  const again = await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  assert.equal(again.ok, true)
  assert.ok(!again.deduped, 'a replaced upload must be readable again')
  assert.equal(rows(fake).length, 2)
})

test('the file’s read state reports the newest job per document, not every attempt', async () => {
  const { fake, svc } = db()
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const [c] = await listQueued(svc)
  await finish(svc, await claim(svc, c), { status: 'failed', code: 'refusal', error: 'declined' })

  // A second document is still waiting.
  await enqueueRead(svc, { loanFile: LOAN, document: DOC2 })

  const state = await readStateForFile(svc, LOAN.id)
  assert.deepEqual(state.pending, [{ documentId: DOC2.id, status: 'queued' }])
  assert.deepEqual(state.failed, [{ documentId: DOC.id, code: 'refusal' }])

  // Re-uploading the failed one supersedes its history rather than stacking beside it.
  await enqueueRead(svc, { loanFile: LOAN, document: DOC })
  const after = await readStateForFile(svc, LOAN.id)
  assert.deepEqual(after.failed, [], 'a retried document must stop reading as failed')
  assert.equal(after.pending.length, 2)
  assert.equal(rows(fake).length, 3, 'the earlier attempt is history, not deleted')
})

test('an enqueue that cannot reach the database never fails the upload', async () => {
  // The contract the upload endpoint depends on: a document we already hold must never be
  // reported to the borrower as failed because a bookkeeping insert was.
  const { svc } = db()
  const broken = { from: () => { throw new Error('connection reset') } }
  const out = await enqueueRead(broken, { loanFile: LOAN, document: DOC })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'unavailable')
  // And a missing target is refused rather than written as a half-row.
  assert.equal((await enqueueRead(svc, { loanFile: LOAN, document: null })).reason, 'missing_target')
})
