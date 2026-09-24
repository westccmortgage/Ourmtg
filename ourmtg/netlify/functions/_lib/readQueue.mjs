// The read queue — persistence only.
//
// Two callers: the upload endpoint enqueues, the worker drains. Neither of them decides anything
// about mortgages, and this file decides nothing about scheduling policy beyond what a database
// can enforce.
//
// The claim is a compare-and-swap, not a lock: UPDATE … WHERE id = ? AND status = 'queued',
// returning the row. Postgres serialises the two updates; the loser gets zero rows back and
// moves on. Two workers running at once therefore cost one wasted round trip, never one document
// read (and billed) twice.

import { randomUUID } from 'node:crypto'

const TABLE = 'document_read_jobs'

// How long a claim is believed before the job is considered abandoned. A read takes tens of
// seconds; a worker that has held one for ten minutes is a worker that died mid-flight, and the
// document is still sitting there unread.
export const CLAIM_TTL_MS = 10 * 60 * 1000

// Three tries at a document. Enough to ride out a provider blip; few enough that a document
// which kills its worker every time stops consuming a slot on every tick forever.
export const MAX_ATTEMPTS = 3

/**
 * Record that a document is owed a read.
 *
 * Fail-soft by contract: the caller is an upload endpoint, and an upload that succeeded must not
 * be reported as failed because the queue was unreachable. A dropped enqueue costs a delayed
 * read, which the panel's manual button and the next upload both recover from.
 *
 * @returns {Promise<{ok: true, job: object|null, deduped?: boolean}|{ok: false, reason: string}>}
 */
export async function enqueueRead(svc, { loanFile, document, requestedBy = 'borrower_upload', correlationId = null }) {
  if (!loanFile?.id || !document?.id) return { ok: false, reason: 'missing_target' }
  try {
    const { data, error } = await svc.from(TABLE).insert({
      organization_id: loanFile.organization_id || null,
      loan_file_id: loanFile.id,
      document_id: document.id,
      // Written explicitly rather than left to the column defaults. The last time this codebase
      // trusted a default (findings.status) a storage layer that did not apply it silently
      // emptied a review queue; an attempt counter that arrives as undefined would make
      // `attempts + 1` NaN and the retry bound meaningless.
      status: 'queued',
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
      requested_by: requestedBy,
      correlation_id: correlationId || randomUUID(),
    }).select('*').maybeSingle()

    // 23505 is the live-job index doing its job: this document already has a read owed or in
    // flight. That is the desired outcome, not an error.
    if (error) {
      if (error.code === '23505') return { ok: true, job: null, deduped: true }
      return { ok: false, reason: 'insert_failed' }
    }
    return { ok: true, job: data || null }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * Put abandoned claims back on the queue.
 *
 * Bounded by max_attempts on the claim side, so a job that kills its worker every time cannot
 * loop forever — it runs out of attempts and lands in `failed` where a person can see it.
 */
export async function requeueStale(svc, { now = Date.now(), ttlMs = CLAIM_TTL_MS } = {}) {
  const cutoff = new Date(now - ttlMs).toISOString()
  const { data, error } = await svc.from(TABLE)
    .update({ status: 'queued', claimed_at: null })
    .eq('status', 'running')
    .lt('claimed_at', cutoff)
    .select('id')
  if (error) return 0
  return (data || []).length
}

/** The oldest queued jobs, as candidates. Claiming them is a separate, racing step. */
export async function listQueued(svc, { limit = 5 } = {}) {
  const { data, error } = await svc.from(TABLE)
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error('read queue: ' + error.message)
  return data || []
}

/**
 * Take ownership of one job, or return null if another worker got there first.
 *
 * A job that has already used its attempts is retired here rather than claimed: the alternative
 * is a poison document that consumes a worker slot on every tick forever.
 */
export async function claim(svc, job, { now = Date.now() } = {}) {
  // Number(undefined) is NaN and Number(null) is 0 — neither is "no attempts yet" unless it is
  // said so. Absence means zero attempts; an absent ceiling means the default ceiling.
  const attempts = Number.isFinite(Number(job.attempts)) ? Number(job.attempts) : 0
  const ceiling = Number.isFinite(Number(job.max_attempts)) ? Number(job.max_attempts) : MAX_ATTEMPTS
  if (attempts >= ceiling) {
    await finish(svc, job, { status: 'failed', code: 'attempts_exhausted', error: 'Gave up after repeated failures.', now })
    return null
  }
  const { data, error } = await svc.from(TABLE)
    .update({ status: 'running', attempts: attempts + 1, claimed_at: new Date(now).toISOString() })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('*')
  if (error) return null
  return (data || [])[0] || null
}

/** Mark a claimed job done, failed, or back on the queue for another try. */
export async function finish(svc, job, { status, code = null, error = null, now = Date.now() }) {
  const patch = {
    status,
    last_error_code: code,
    // Truncated: last_error is operator-facing and carries a provider message, which has no
    // business growing without bound in a table anyone might dump.
    last_error: error ? String(error).slice(0, 500) : null,
    finished_at: status === 'queued' ? null : new Date(now).toISOString(),
  }
  if (status === 'queued') patch.claimed_at = null
  const { error: uErr } = await svc.from(TABLE).update(patch).eq('id', job.id)
  return !uErr
}

/**
 * What the file's screens need: is anything still being read, and did anything give up?
 *
 * Both views use this. The borrower's copy says "we're reading it"; the team's copy says the
 * same thing plus which document and why it failed. The FACT is one query, so the two screens
 * cannot disagree about whether a read is outstanding.
 */
export async function readStateForFile(svc, loanFileId) {
  const { data, error } = await svc.from(TABLE)
    .select('id, document_id, status, attempts, max_attempts, last_error_code, created_at, finished_at')
    .eq('loan_file_id', loanFileId)
    .order('created_at', { ascending: false })
  if (error) return { pending: [], failed: [] }
  const rows = data || []
  // One row per document: the newest job is the truth about that document, and older attempts
  // are history. Rows arrive newest-first, so the first sighting of a document id wins.
  const seen = new Set()
  const latest = []
  for (const r of rows) {
    if (seen.has(r.document_id)) continue
    seen.add(r.document_id)
    latest.push(r)
  }
  return {
    pending: latest.filter((r) => r.status === 'queued' || r.status === 'running')
      .map((r) => ({ documentId: r.document_id, status: r.status })),
    failed: latest.filter((r) => r.status === 'failed')
      .map((r) => ({ documentId: r.document_id, code: r.last_error_code })),
  }
}
