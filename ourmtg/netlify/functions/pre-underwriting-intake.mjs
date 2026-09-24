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
// This endpoint is now one of two callers of the same work: the borrower's upload queues the
// identical read (pre-underwriting-read-worker), so a file gets read whether or not anyone
// presses a button. What is internal-only is this SYNCHRONOUS, findings-returning view of it.
//
// What it still owns is step 1 — authorize, then load the document, so nothing is read for a
// file you cannot see. Steps 2 through 6 live in _lib/documentRead.mjs.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { createRateLimiter } from './_lib/ratelimit.mjs'
import { logEvent } from './_lib/safelog.mjs'
import { preUnderwritingEnabled } from './_lib/documentIntake.mjs'
import { newId } from './_lib/preUnderwritingRepo.mjs'
import { readAndAnalyse, NOT_MEANING } from './_lib/documentRead.mjs'

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
      .select('id, loan_file_id, doc_key, label, storage_path, status, reject_reason')
      .eq('id', body.documentId)
      .maybeSingle()
    if (dErr) return json({ ok: false, error: 'Database error' }, 500)
    if (!document) return json({ ok: false, error: 'Document not found' }, 404)
    // The document id is never trusted as proof of which file it belongs to.
    if (document.loan_file_id !== loanFile.id) {
      return json({ ok: false, error: 'Document not found' }, 404)
    }
    if (String(document.reject_reason || '').startsWith('__REMOVED__:')) {
      return json({ ok: false, error: 'Document not found' }, 404)
    }

    // ── 2–6: read it and re-analyse the file ───────────────────────────────
    const result = await readAndAnalyse(svc, {
      loanFile, document, actor: auth.user.id, correlationId,
    })
    if (!result.ok) {
      return json({ ok: false, error: result.error, code: result.code }, result.status)
    }
    const { extraction, read, analysis } = result

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
        fieldCount: read.value.fields.length + (read.value.taxLineItems || []).length,
        tradelineCount: (read.value.tradelines || []).length,
        taxFormCount: (read.value.taxForms || []).length,
        taxLineItemCount: (read.value.taxLineItems || []).length,
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
