// Read one document, then re-analyse the whole file it belongs to.
//
// This used to live inside pre-underwriting-intake.mjs, where it was reachable only by a signed-in
// internal user pressing a button. The borrower follow-up loop needs the SAME work to happen the
// moment an upload lands — with no employee in the loop — so the work moved here and the endpoint
// became one of its two callers. There is deliberately only one definition of "read this document":
// a second one would drift, and the two callers would start disagreeing about what a file contains.
//
// What does NOT move here is who is allowed to see the result. readAndAnalyse returns findings
// because the rules produce them and they must be stored; the caller decides whether a human ever
// sees them. The borrower-facing caller never looks at the `analysis` it gets back — it reads the
// completeness gaps instead, which is the half a borrower is allowed to act on.
//
// Order matters and is the same as it always was:
//   1. fetch the bytes (signature-verified inside downloadDocument)
//   2. malware scan               ← a model must never be the first thing to parse an upload
//   3. read                       ← may time out, may be refused
//   4. store the extraction, superseding the previous read of this document
//   5. re-run every rule over the WHOLE file
//   6. replace pending findings, keep the ones a human already decided
//
// A failure at 1–3 leaves the document exactly as it was: uploaded, unread, waiting. Nothing a
// borrower sent is ever lost because a model was slow.

import { createDocumentIntake, readDocument } from './documentIntake.mjs'
import {
  downloadDocument, saveExtraction, listExtractions, replaceFindings, findingIds,
} from './preUnderwritingRepo.mjs'
import { createScanProvider, preUnderwritingScanRequired, scanDecision } from './scan-provider.mjs'
import { logEvent } from './safelog.mjs'
import { buildAnalysisContext } from '../../../src/features/pre-underwriting/analysisContext.js'
import { applicationFactsFromState } from '../../../src/features/pre-underwriting/applicationFacts.js'
import { runRules } from '../../../src/features/pre-underwriting/rules.js'

/**
 * Read one document and re-analyse its file.
 *
 * @returns {Promise<{ok: true, extraction: object, read: object, analysis: object}
 *                  |{ok: false, code: string, status: number, error: string, retryable: boolean}>}
 */
export async function readAndAnalyse(svc, { loanFile, document, actor = null, correlationId }) {
  // ── 1: fetch ──────────────────────────────────────────────────────────────
  const file = await downloadDocument(svc, document)
  if (!file.ok) {
    logEvent('pu.intake.unreadable', { severity: 'info', requestId: correlationId, code: file.code })
    return fail(file.code, 422, { retryable: file.code === 'download_failed' })
  }

  // ── 2: scan ───────────────────────────────────────────────────────────────
  let scanner
  try { scanner = createScanProvider() }
  catch {
    return fail('scan_not_configured', 503, { retryable: true })
  }
  const scan = await scanner.scan({
    bytes: Buffer.from(file.dataBase64, 'base64'),
    detectedContentType: file.mediaType,
    correlationId,
  })
  const gate = scanDecision(scan, { required: preUnderwritingScanRequired() })
  if (!gate.ok) {
    logEvent('pu.intake.scan_blocked', {
      severity: scan.status === 'infected' ? 'warn' : 'error', requestId: correlationId,
      code: gate.code, provider: scanner.name,
    })
    // An infected file is a verdict, not a hiccup: retrying reaches the same answer and burns
    // a scan credit each time. A scanner that merely errored is worth another attempt.
    return { ok: false, code: gate.code, status: gate.status, error: gate.error, retryable: scan.status !== 'infected' }
  }

  // ── 3: read ───────────────────────────────────────────────────────────────
  let intake
  try { intake = createDocumentIntake() }
  catch { return fail('provider_not_configured', 503, { retryable: true }) }

  const read = await readDocument(intake, {
    mediaType: file.mediaType,
    dataBase64: file.dataBase64,
    // What the checklist says it should be. Offered as context; the model classifies from the
    // page, and a confident disagreement is surfaced rather than smoothed over.
    expectedDocKey: document.doc_key || null,
    correlationId,
  })
  if (!read.ok) {
    const code = read.error?.code || 'read_failed'
    // A refusal and an unreadable format are settled answers about this file. A timeout or a
    // provider error is a bad minute, and the queue should come back to it.
    const settled = code === 'refusal' || code === 'unsupported_media_type' || code === 'max_tokens'
    return fail(code, settled ? 422 : 502, { retryable: !settled })
  }

  // ── 4: store ──────────────────────────────────────────────────────────────
  const extraction = await saveExtraction(svc, {
    loanFile, document, value: read.value, meta: read.meta, actor,
  })

  // ── 5 + 6: re-analyse the whole file ──────────────────────────────────────
  // Whole file, not just this document: a new pay stub can contradict a W-2 that was already on
  // file, and a rule that only ever saw one document at a time would never notice. The
  // borrower's own answers ride along — without them undisclosedLiabilities compares the report
  // against nothing and calls every declared debt undisclosed.
  const application = await applicationFactsForFile(svc, loanFile)
  const analysis = await reanalyse(svc, { loanFile, application, correlationId })

  return { ok: true, extraction, read, analysis }
}

const fail = (code, status, { retryable = false } = {}) => ({
  ok: false, code, status, error: MESSAGES[code] || 'This document could not be read.', retryable,
})

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

/**
 * Re-run every rule over everything currently known about the file.
 *
 * Exported so the review endpoint can do the same thing after a correction — one definition of
 * "analyse this file", not two that drift.
 */
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

export const MESSAGES = Object.freeze({
  not_uploaded: 'That document has been requested but nothing has been uploaded yet.',
  download_failed: 'The stored file could not be opened.',
  empty_file: 'That file is empty.',
  file_too_large: 'That file is too large to read. A scan under 20 MB works best.',
  unsupported_file_content: 'The uploaded file is not a supported PDF, JPG, PNG, or HEIC document.',
  content_type_mismatch: 'The uploaded file contents do not match its reported file type.',
  unsupported_media_type: 'That file type cannot be read. PDF, JPEG, PNG, or WEBP — an iPhone photo may need converting from HEIC.',
  refusal: 'The reader declined this document. A person should open it.',
  max_tokens: 'That document is too long to read in one pass.',
  read_failed: 'The document could not be read just now. Nothing was lost — try again.',
  scan_not_configured: 'Document security scanning is not configured.',
  provider_not_configured: 'Document reading is not configured.',
})

export const NOT_MEANING = Object.freeze([
  'an approval or a pre-approval',
  'a credit decision',
  'an underwriting opinion',
  'a commitment to lend',
])
