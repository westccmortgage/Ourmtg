// POST /.netlify/functions/pre-underwriting-intake   (internal-only, Bearer JWT)
//
// Read one uploaded document and re-run the analysis for its file.
//
// Body: { loanFileId, documentId, idempotencyKey }
//
// INTERNAL ONLY, and that is a product decision rather than a permissions oversight. Reading a
// document produces findings — conclusions about the applicant — and the boundary doc says those
// stay inside until a human releases them. A borrower uploading a pay stub still gets the useful
// half automatically: the completeness check that tells them a page is missing.
//
// The ordering matters and mirrors application-turn's:
//   1. authorize, then load the document          ← nothing is read for a file you cannot see
//   2. read it (may time out, may be refused)
//   3. validate against the contract              ← model output is untrusted
//   4. store the extraction, superseding the old
//   5. re-run every rule over the whole file
//   6. replace pending findings, keep decided ones
//
// A failure at 2 or 3 leaves the document exactly as it was: uploaded, unread, waiting. Nothing
// a borrower sent is ever lost because a model was slow.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { createRateLimiter } from './_lib/ratelimit.mjs'
import { logEvent } from './_lib/safelog.mjs'
import {
  preUnderwritingEnabled, createDocumentIntake, readDocument,
} from './_lib/documentIntake.mjs'
import {
  downloadDocument, saveExtraction, listExtractions, replaceFindings,
  findingIds, newId,
} from './_lib/preUnderwritingRepo.mjs'
import { buildAnalysisContext } from '../../src/features/pre-underwriting/analysisContext.js'
import { applicationFactsFromState } from '../../src/features/pre-underwriting/applicationFacts.js'
import { runRules } from '../../src/features/pre-underwriting/rules.js'

// Reading a document is a model call against a whole PDF — far more expensive than a turn, and
// nobody legitimately reads sixty documents a minute.
const intakeLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!preUnderwritingEnabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body

  if (!isUuid(body.loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  if (!isUuid(body.documentId)) return json({ ok: false, error: 'Invalid documentId' }, 400)
  if (!isValidIdempotencyKey(body.idempotencyKey)) {
    return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
  }

  const limited = intakeLimiter.check(`pu:${auth.user.id}`)
  if (!limited.allowed) return json({ ok: false, error: 'Please slow down a moment.' }, 429)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, body.loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    console.error('[pre-underwriting-intake] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  const correlationId = newId()
  try {
    const { data: document, error: dErr } = await svc
      .from('loan_documents')
      .select('id, loan_file_id, doc_key, label, storage_path, status')
      .eq('id', body.documentId)
      .maybeSingle()
    if (dErr) return json({ ok: false, error: 'Database error' }, 500)
    if (!document) return json({ ok: false, error: 'Document not found' }, 404)
    // The document id is never trusted as proof of which file it belongs to.
    if (document.loan_file_id !== loanFile.id) {
      return json({ ok: false, error: 'Document not found' }, 404)
    }

    // ── 2: fetch and read ──────────────────────────────────────────────────
    const file = await downloadDocument(svc, document)
    if (!file.ok) {
      logEvent('pu.intake.unreadable', { severity: 'info', requestId: correlationId, code: file.code })
      return json({ ok: false, error: MESSAGES[file.code] || 'This file could not be read.', code: file.code }, 422)
    }

    let intake
    try {
      intake = createDocumentIntake()
    } catch {
      return json({ ok: false, error: 'Document reading is not configured.', code: 'provider_not_configured' }, 503)
    }

    const read = await readDocument(intake, {
      mediaType: file.mediaType,
      dataBase64: file.dataBase64,
      // What the checklist says it should be. Offered as context; the model classifies from the
      // page, and a confident disagreement is surfaced rather than smoothed over.
      expectedDocKey: document.doc_key || null,
      correlationId,
    })
    if (!read.ok) {
      return json({
        ok: false,
        error: MESSAGES[read.error?.code] || 'The document could not be read just now. Nothing was lost — try again.',
        code: read.error?.code || 'read_failed',
      }, read.error?.code === 'unsupported_media_type' ? 422 : 502)
    }

    // ── 4: store ───────────────────────────────────────────────────────────
    const extraction = await saveExtraction(svc, {
      loanFile, document, value: read.value, meta: read.meta, actor: auth.user.id,
    })

    // ── 5 + 6: re-analyse the whole file ───────────────────────────────────
    // Whole file, not just this document: a new pay stub can contradict a W-2 that was already
    // on file, and a rule that only ever saw one document at a time would never notice.
    // The borrower's own answers ride along — without them undisclosedLiabilities compares the
    // report against nothing and calls every declared debt undisclosed.
    const application = await applicationFactsForFile(svc, loanFile)
    const analysis = await reanalyse(svc, { loanFile, application, correlationId })

    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId: loanFile.id,
      action: 'pre_underwriting_intake', target: document.id, req,
    })

    return json({
      ok: true,
      extraction: {
        id: extraction.id,
        docKey: read.value.docKey,
        proposedDocKey: read.value.proposedDocKey,
        docKeyConfidence: read.value.docKeyConfidence,
        docKeyMismatch: read.value.docKeyMismatch,
        fieldCount: read.value.fields.length,
        tradelineCount: (read.value.tradelines || []).length,
        minFieldConfidence: read.value.minFieldConfidence,
        needsHumanReview: read.value.needsHumanReview,
        reviewReasons: read.value.reviewReasons,
      },
      findings: analysis,
      // Said on every response that carries findings, because a screen can be built from this
      // payload by someone who never read the boundary doc.
      notMeaning: NOT_MEANING,
    })
  } catch (e) {
    logEvent('pu.intake.error', { severity: 'error', requestId: correlationId, message: e?.message })
    return json({ ok: false, error: 'Could not process that document.', requestId: correlationId }, 500)
  }
}

/**
 * Re-run every rule over everything currently known about the file.
 *
 * Exported so the review endpoint can do the same thing after a correction — one definition of
 * "analyse this file", not two that drift.
 */
/** The borrower's 1003 answers for this file, or {} when no application exists yet. */
export async function applicationFactsForFile(svc, loanFile) {
  const { data: app } = await svc
    .from('mortgage_applications')
    .select('id')
    .eq('loan_file_id', loanFile.id)
    .order('application_version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!app) return {}
  const { data: state } = await svc
    .from('application_field_state')
    .select('field_path, normalized_value, status')
    .eq('application_id', app.id)
  return applicationFactsFromState(state || [])
}

export async function reanalyse(svc, { loanFile, application = {}, correlationId }) {
  const extractions = await listExtractions(svc, loanFile.id)
  const ctx = buildAnalysisContext({
    extractions,
    application,
    id: findingIds(loanFile.id),
  })
  const { findings, errors } = runRules(ctx)
  if (errors.length) {
    // A rule that throws is contained upstream; it is logged here so a silently missing finding
    // is discoverable rather than merely absent.
    logEvent('pu.rules.error', { severity: 'error', requestId: correlationId, rules: errors.map((e) => e.rule) })
  }
  const written = await replaceFindings(svc, { loanFile, findings, runId: correlationId })
  return { produced: findings.length, ...written, ruleErrors: errors.length }
}

const MESSAGES = {
  not_uploaded: 'That document has been requested but nothing has been uploaded yet.',
  download_failed: 'The stored file could not be opened.',
  empty_file: 'That file is empty.',
  file_too_large: 'That file is too large to read. A scan under 20 MB works best.',
  unsupported_media_type: 'That file type cannot be read. PDF, JPEG, PNG, or WEBP — an iPhone photo may need converting from HEIC.',
  refusal: 'The reader declined this document. A person should open it.',
  max_tokens: 'That document is too long to read in one pass.',
}

export const NOT_MEANING = Object.freeze([
  'an approval or a pre-approval',
  'a credit decision',
  'an underwriting opinion',
  'a commitment to lend',
])
