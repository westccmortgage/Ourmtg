// Scheduled. Drains the document read queue, then tells the borrower what is still missing.
//
// This is the function that removes the loan officer from routine iterations. Before it, a
// borrower's upload sat unread until somebody opened the panel and pressed a button; the missing
// page was discovered by a person, and chased by a person, on a phone call. Here the read
// happens because the upload happened, and the ask is composed from what was actually received.
//
// ── Reachability ────────────────────────────────────────────────────────────
// Netlify scheduled functions have no public URL: "You can't invoke scheduled functions directly
// with a URL" (docs.netlify.com/build/functions/scheduled-functions). So the schedule is the only
// way in on a deployed site. The key check below is therefore not the control that keeps
// strangers out — the absence of a route is — it is what keeps a LOCAL `netlify dev` or a future
// re-plumbing of this file as an ordinary function from becoming an unauthenticated way to spend
// model credits. It fails closed: no key configured and no schedule marker ⇒ 404.
//
// ── What one tick does ──────────────────────────────────────────────────────
//   1. put abandoned claims back on the queue
//   2. claim up to BATCH jobs, one at a time, compare-and-swap so two ticks cannot collide
//   3. read each document and re-analyse its whole file      (_lib/documentRead.mjs)
//   4. recompute what the file still needs                   (_lib/fileState.mjs)
//   5. write ONE follow-up to the borrower, if there is something new to say
//
// Step 5 reads `borrowerView` only. A finding is never borrower-owned, so it is not in the
// input — not filtered out of the output, absent from the input.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { newId } from './_lib/preUnderwritingRepo.mjs'
import { logAccess } from './_lib/portal.mjs'
import { preUnderwritingEnabled } from './_lib/documentIntake.mjs'
import { readAndAnalyse } from './_lib/documentRead.mjs'
import { requeueStale, listQueued, claim, finish } from './_lib/readQueue.mjs'
import { loadFileState } from './_lib/fileState.mjs'
import { logEvent } from './_lib/safelog.mjs'
import { composeFollowUp } from '../../src/features/pre-underwriting/followUp.js'
import { getDocumentType } from '../../src/features/pre-underwriting/documentCatalog.js'

// Small on purpose. A read is a model call against a whole PDF; a tick that tries to do twenty
// of them is a tick that gets killed halfway and leaves half its claims to expire.
const BATCH = 3

export default async (req) => {
  if (!isConfigured()) return new Response('not configured', { status: 503 })
  if (!preUnderwritingEnabled()) return new Response('not enabled', { status: 404 })
  if (!(await authorized(req))) return new Response('Not found', { status: 404 })

  const svc = admin()
  const runId = newId()
  const out = { claimed: 0, read: 0, failed: 0, messaged: 0 }

  try {
    await requeueStale(svc)
    const candidates = await listQueued(svc, { limit: BATCH })

    for (const candidate of candidates) {
      const job = await claim(svc, candidate)
      if (!job) continue // another tick got it, or it ran out of attempts
      out.claimed += 1
      const result = await runOne(svc, job, runId)
      if (result.read) out.read += 1
      if (result.failed) out.failed += 1
      if (result.messaged) out.messaged += 1
    }
  } catch (e) {
    logEvent('pu.worker.error', { severity: 'error', requestId: runId, message: e?.message })
    return new Response(JSON.stringify({ ok: false, ...out }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true, ...out }), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function runOne(svc, job, runId) {
  const [{ data: loanFile }, { data: document }] = await Promise.all([
    svc.from('loan_files').select('*').eq('id', job.loan_file_id).maybeSingle(),
    svc.from('loan_documents')
      .select('id, loan_file_id, doc_key, label, storage_path, status, reject_reason')
      .eq('id', job.document_id).maybeSingle(),
  ])

  // The document was removed between the upload and this tick. Not a failure — there is simply
  // nothing to read, and retrying would reach the same answer three more times.
  if (!loanFile || !document || document.loan_file_id !== job.loan_file_id
      || String(document.reject_reason || '').startsWith('__REMOVED__:')) {
    // Audited even though nothing was read. "The worker looked and the document was gone" is a
    // fact somebody may need in a year, and an attempt with no record at all is indistinguishable
    // from an attempt that never happened.
    await audit(svc, job.loan_file_id, 'pre_underwriting_intake_auto', `${job.document_id}:document_gone`)
    await finish(svc, job, { status: 'failed', code: 'document_gone', error: 'The document is no longer on this file.' })
    return { failed: true }
  }

  let read = null
  try {
    read = await readAndAnalyse(svc, {
      loanFile, document, actor: null, correlationId: job.correlation_id || runId,
    })
  } catch (e) {
    logEvent('pu.worker.read_threw', { severity: 'error', requestId: runId, message: e?.message })
    // Audited: by the time this threw, the bytes may already have been fetched and the provider
    // may already have seen them. An unrecorded read is worse than a failed one.
    await audit(svc, loanFile.id, 'pre_underwriting_intake_auto', `${document.id}:exception`)
    // An exception is the one case we genuinely do not understand, so the job goes back on the
    // queue and the attempt counter — not this branch — decides when to stop.
    await finish(svc, job, { status: 'queued', code: 'exception', error: e?.message })
    return { failed: true }
  }

  // Audited like every other read of a borrower's document. `portal_user` is null because no
  // person did this — that null IS the record that it was the system, and a document read with
  // no entry at all would be a read nobody can account for a year from now.
  await audit(svc, loanFile.id, 'pre_underwriting_intake_auto', `${document.id}:${read.ok ? 'read' : read.code}`)

  let outcome
  if (read.ok) {
    outcome = await finish(svc, job, { status: 'done' })
  } else if (read.retryable) {
    outcome = await finish(svc, job, { status: 'queued', code: read.code, error: read.error })
  } else {
    // A settled answer: a refusal, an unreadable format, an infected file. Retrying reaches the
    // same place, so the job stops and a person is the next step.
    outcome = await finish(svc, job, { status: 'failed', code: read.code, error: read.error })
  }

  // This worker stalled long enough for the job to be reclaimed, and somebody else owns it now.
  // Their run is the one that reports; speaking to the borrower here would be a second message
  // about the same document from a run whose result was already discarded.
  if (outcome.lost) {
    logEvent('pu.worker.claim_lost', { severity: 'warn', requestId: runId })
    await audit(svc, loanFile.id, 'borrower_followup_suppressed', `${document.id}:claim_lost`)
    return { failed: true }
  }

  // A job that merely went back on the queue has not finished; saying anything to the borrower
  // now would be reporting on a read that is still in progress.
  if (!read.ok && read.retryable) {
    await audit(svc, loanFile.id, 'borrower_followup_suppressed', `${document.id}:read_will_retry`)
    return { failed: true }
  }

  const messaged = await followUp(svc, {
    loanFile, document, readFailed: !read.ok, runId,
  })
  return { read: read.ok, failed: !read.ok, messaged }
}

/**
 * One message, only if there is something new to say.
 *
 * The previous message is read back out of the timeline rather than tracked in a column: the
 * timeline is where it was actually delivered, so it cannot drift from what the borrower saw.
 */
async function followUp(svc, { loanFile, document, readFailed, runId }) {
  const trail = (outcome) => audit(svc, loanFile.id, outcome.startsWith('sent')
    ? 'borrower_followup_sent' : 'borrower_followup_suppressed', `${document.id}:${outcome}`)
  try {
    const state = await loadFileState(svc, loanFile)
    const { data: prior } = await svc
      .from('loan_messages')
      .select('body')
      .eq('loan_file_id', loanFile.id)
      .eq('author_role', 'assistant')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const composed = composeFollowUp({
      tasks: state.tasks,
      justRead: borrowerNameFor(document),
      lastMessage: prior?.body || null,
      readFailed,
    })
    // Every decision is recorded, including the decision to say nothing. A borrower asking "why
    // did nobody tell me?" and a reviewer asking "why did it message them twice?" are the same
    // question, and neither is answerable from a silence.
    if (!composed.send) {
      await trail(composed.reason)
      logEvent('pu.worker.followup_suppressed', {
        severity: 'info', requestId: runId, reason: composed.reason,
      })
      return false
    }

    const { error } = await svc.from('loan_messages').insert({
      loan_file_id: loanFile.id,
      owner_user_id: loanFile.owner_user_id,
      direction: 'out',
      author_role: 'assistant',
      body: composed.body,
      channel: 'portal',
    })
    if (error) {
      await trail('insert_failed')
      return false
    }
    await trail(`sent:${composed.outstanding}`)
    logEvent('pu.worker.followup', {
      severity: 'info', requestId: runId, outstanding: composed.outstanding,
    })
    return true
  } catch (e) {
    // The read succeeded and is stored. Failing to say so is a worse day, not a lost document.
    logEvent('pu.worker.followup_failed', { severity: 'warn', requestId: runId, message: e?.message })
    await trail('error').catch(() => {})
    return false
  }
}

/**
 * One durable audit row, best-effort.
 *
 * `portal_user` is null on every one of these: no person did it. That null IS the record that it
 * was the system. logAccess is already fail-soft, so a failed audit write never costs a read.
 */
const audit = (svc, loanFileId, action, target) =>
  logAccess(svc, { portalUser: null, loanFileId, action, target })

// What the borrower calls the thing they just sent. The catalog label is the borrower-facing
// name; `label` on the row can be an internal filing name, and doc_key is a developer's word.
const borrowerNameFor = (document) =>
  getDocumentType(document.doc_key)?.label?.toLowerCase() || 'document'

/**
 * Netlify's scheduled invocation posts `{ next_run }` and nothing else. Anything else must carry
 * the operator key, and when no key is configured there is no non-scheduled way in at all.
 */
async function authorized(req) {
  const key = process.env.OURMTG_READ_WORKER_KEY || ''
  const presented = req.headers.get('x-ourmtg-worker-key') || ''
  if (key && presented && timingSafeEqual(key, presented)) return true
  try {
    const body = await req.clone().json()
    return typeof body?.next_run === 'string'
  } catch {
    return false
  }
}

// Constant-time within the bounds of what a header comparison can offer: length is compared
// first because an early return on it leaks only the length, which is not the secret.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Every minute. The borrower is sitting on the upload screen waiting to find out whether what
// they sent was enough, and a five-minute tick is five minutes of a blank answer. This is the
// knob to turn if reads ever become expensive enough to batch.
export const config = { schedule: '* * * * *' }
