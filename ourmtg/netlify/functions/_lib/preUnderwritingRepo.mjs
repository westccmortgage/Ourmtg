// Autopilot Pre-Underwriting — persistence.
//
// The pure layers never touch the database and this module never makes product decisions, the
// same split applicationRepo.mjs keeps. What lives here is the part that cannot be pure: reading
// a document out of storage, writing an extraction, and replacing a file's findings atomically
// enough that a reviewer never sees half a run.

import { randomUUID, createHash } from 'node:crypto'
import { getDocumentType } from '../../../src/features/pre-underwriting/documentCatalog.js'

export const newId = () => randomUUID()

/**
 * Stable ids for findings, derived from the file and the rule's own seed.
 *
 * Deterministic on purpose: the same file in the same state produces the same finding id on
 * every run, so "is this the finding I dismissed yesterday, or a new one?" has an answer that
 * does not depend on when the job happened to run.
 */
export const findingIds = (loanFileId) => (seed) =>
  createHash('sha256').update(`${loanFileId}::${seed}`).digest('hex').slice(0, 32)

const BUCKET = 'ourmtg-docs'
// Roughly 20MB of file. Bigger than any pay stub and smaller than the API's own ceiling, so an
// oversized upload fails here with an explanation rather than as a provider error.
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

/**
 * Pull one document out of storage as base64.
 *
 * @returns {{ok: true, dataBase64: string, mediaType: string, bytes: number}
 *          |{ok: false, code: string}}
 */
export async function downloadDocument(svc, doc) {
  if (!doc?.storage_path) return { ok: false, code: 'not_uploaded' }
  const { data, error } = await svc.storage.from(BUCKET).download(doc.storage_path)
  if (error || !data) return { ok: false, code: 'download_failed' }

  const buf = Buffer.from(await data.arrayBuffer())
  if (buf.byteLength === 0) return { ok: false, code: 'empty_file' }
  if (buf.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, code: 'file_too_large' }

  return {
    ok: true,
    dataBase64: buf.toString('base64'),
    // Storage reports what was uploaded; the path extension is only a fallback, because a
    // borrower's phone will happily name a HEIC "photo.jpg".
    mediaType: data.type || mediaTypeFromPath(doc.storage_path),
    bytes: buf.byteLength,
  }
}

function mediaTypeFromPath(path) {
  const ext = String(path).toLowerCase().split('.').pop()
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heic',
  }[ext] || ''
}

/** Store one read, superseding the previous live read of the same document. */
export async function saveExtraction(svc, { loanFile, document, value, meta, actor }) {
  const row = {
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    document_id: document.id,
    doc_key: value.docKey,
    proposed_doc_key: value.proposedDocKey,
    doc_key_confidence: value.docKeyConfidence,
    expected_doc_key: value.expectedDocKey,
    doc_key_mismatch: Boolean(value.docKeyMismatch),
    legible: value.legible !== false,
    // Tradelines ride with the fields rather than in a column of their own: they are read as a
    // set with them, and a separate column would be a second place to forget to supersede.
    fields: { fields: value.fields || [], tradelines: value.tradelines || [] },
    field_count: (value.fields || []).length,
    min_field_confidence: value.minFieldConfidence,
    rejected: meta?.rejected || [],
    notes: value.notes,
    needs_human_review: Boolean(value.needsHumanReview),
    review_reasons: value.reviewReasons || [],
    provider_name: meta?.provider || null,
    provider_model: meta?.modelUsed || meta?.model || null,
    prompt_version: meta?.promptVersion || null,
    catalog_version: CATALOG_VERSION,
    input_tokens: meta?.inputTokens ?? null,
    output_tokens: meta?.outputTokens ?? null,
    duration_ms: meta?.ms ?? null,
    created_by: actor || null,
  }

  const { data, error } = await svc.from('document_extractions').insert(row).select('*').maybeSingle()
  if (error) throw new Error('extraction write: ' + error.message)

  // Point every prior live read of this document at the new one. Done after the insert so a
  // failure leaves the old read in place rather than leaving the document with none.
  await svc.from('document_extractions')
    .update({ superseded_by: data.id })
    .eq('document_id', document.id)
    .is('superseded_by', null)
    .neq('id', data.id)
    .then(null, () => {})

  return data
}

/** Every live read on a file, in the shape the pure layers expect. */
export async function listExtractions(svc, loanFileId) {
  const { data, error } = await svc
    .from('document_extractions')
    .select('*')
    .eq('loan_file_id', loanFileId)
    .is('superseded_by', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error('extractions read: ' + error.message)
  return (data || []).map(fromRow)
}

const fromRow = (r) => ({
  id: r.id,
  documentId: r.document_id,
  docKey: r.doc_key,
  proposedDocKey: r.proposed_doc_key,
  docKeyConfidence: r.doc_key_confidence,
  expectedDocKey: r.expected_doc_key,
  docKeyMismatch: r.doc_key_mismatch,
  legible: r.legible,
  fields: r.fields?.fields || [],
  tradelines: r.fields?.tradelines || [],
  minFieldConfidence: r.min_field_confidence,
  notes: r.notes,
  needsHumanReview: r.needs_human_review,
  reviewReasons: r.review_reasons || [],
  createdAt: r.created_at,
  supersededBy: r.superseded_by,
})

/**
 * Replace this file's findings with the results of a fresh run.
 *
 * A rule that fires again produces the same finding, and re-inserting it would either violate
 * the live-rule unique index or bury a reviewer in duplicates. So: anything a human has already
 * decided is LEFT ALONE — their judgement outlives a re-run — and only pending findings are
 * superseded and replaced.
 */
export async function replaceFindings(svc, { loanFile, findings, runId, actor }) {
  const { data: existing } = await svc
    .from('pre_underwriting_findings')
    .select('id, rule, status, dedupe_key')
    .eq('loan_file_id', loanFile.id)
    .is('superseded_by', null)

  const decided = new Map()
  const pending = []
  for (const row of existing || []) {
    if (row.status === 'pending_review') pending.push(row)
    // Keyed by the finding's own identity, NOT its rule. undisclosed_liability fires once per
    // creditor: a human's dismissal of the Discover finding must not swallow a brand-new Amex
    // finding just because both share a rule name.
    else decided.set(row.dedupe_key || row.rule, row)
  }

  // A finding a person confirmed, corrected, or dismissed is not re-asked. Re-raising it every
  // time the job runs is how a reviewer learns to ignore the panel.
  const fresh = findings.filter((f) => !decided.has(dedupeKeyOf(f)))

  if (pending.length) {
    // Superseded by nothing in particular — pointing at their own id marks them closed without
    // inventing a successor for findings that simply stopped firing.
    for (const row of pending) {
      await svc.from('pre_underwriting_findings').update({ superseded_by: row.id }).eq('id', row.id)
    }
  }

  if (!fresh.length) return { written: 0, kept: decided.size }

  const rows = fresh.map((f) => ({
    id: undefined,
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    rule: f.rule,
    category: f.category,
    severity: f.severity,
    explanation: f.explanation,
    evidence: f.evidence || [],
    source_documents: f.sourceDocuments || [],
    min_confidence: f.minConfidence,
    needs_human_review: Boolean(f.needsHumanReview),
    // The finding's identity. The live-uniqueness index rides on this, so a rule that fires
    // once per creditor stores one row per creditor instead of failing the whole run on the
    // second insert — the bug that 500ed intake on any file with two undisclosed debts.
    dedupe_key: dedupeKeyOf(f),
    // Explicit, not left to the column default: every read path filters on this value, and a
    // storage layer that happened not to apply defaults would silently empty the review queue.
    status: 'pending_review',
    rules_version: RULES_VERSION,
    catalog_version: CATALOG_VERSION,
    run_id: runId,
  }))

  const { error } = await svc.from('pre_underwriting_findings').insert(rows)
  if (error) throw new Error('findings write: ' + error.message)
  return { written: rows.length, kept: decided.size }
}

/** Live findings on a file, including the ones a human already decided. */
export async function listFindings(svc, loanFileId) {
  const { data, error } = await svc
    .from('pre_underwriting_findings')
    .select('*')
    .eq('loan_file_id', loanFileId)
    .is('superseded_by', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error('findings read: ' + error.message)
  return (data || []).map((r) => ({
    id: r.id,
    rule: r.rule,
    category: r.category,
    severity: r.severity,
    explanation: r.explanation,
    evidence: r.evidence || [],
    sourceDocuments: r.source_documents || [],
    minConfidence: r.min_confidence,
    needsHumanReview: r.needs_human_review,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  }))
}

/** Credit authorizations on a file. */
export async function listAuthorizations(svc, loanFileId) {
  const { data, error } = await svc
    .from('credit_authorizations')
    .select('*')
    .eq('loan_file_id', loanFileId)
    .order('accepted_at', { ascending: false })
  if (error) throw new Error('authorizations read: ' + error.message)
  return (data || []).map((r) => ({
    id: r.id,
    partyIndex: r.party_index,
    documentVersion: r.document_version,
    presentedAt: r.presented_at,
    acceptedAt: r.accepted_at,
    acceptedBy: r.accepted_by,
    revokedAt: r.revoked_at,
  }))
}

/** The documents on a file, so the panel can name what has not been read yet. */
export async function listDocuments(svc, loanFileId) {
  const { data, error } = await svc
    .from('loan_documents')
    .select('id, doc_key, label, status, storage_path, who, uploaded_at')
    .eq('loan_file_id', loanFileId)
  if (error) throw new Error('documents read: ' + error.message)
  return (data || []).filter((d) => getDocumentType(d.doc_key) || d.doc_key)
}

// The deterministic identity rules already stamp on each finding (findingIds above); the rule
// name is the honest fallback for a finding produced without one.
const dedupeKeyOf = (f) => f.id || f.rule

// Versions travel with every row so a finding produced last quarter can still be explained
// after the rules and the catalog have both moved on.
export const CATALOG_VERSION = 'pu-catalog-1'
export const RULES_VERSION = 'pu-rules-1'
