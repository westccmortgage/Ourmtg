// GET  /.netlify/functions/pre-underwriting-review?loanFileId=…   (internal-only)
// POST /.netlify/functions/pre-underwriting-review                (internal-only)
//
// Level 4 — the human. Everything the previous three layers produced arrives here as a working
// panel, and the only actions available are the four a reviewer actually has:
//
//     confirm   this is real; it stays on the file and blocks
//     correct   the underlying reading was wrong; here is the right value
//     dismiss   not an issue on this file, and here is why
//     reanalyse re-run the rules after documents changed
//
// THERE IS NO APPROVE AND NO DENY. Not disabled, not permission-gated — absent. The schema has
// no column for one and this endpoint has no action for one, because a system that could express
// an underwriting decision would eventually be read as making them.
//
// A CORRECTION IS THE MOST VALUABLE THING THIS PRODUCT PRODUCES: it is a case where the rules or
// the extraction were wrong, described by someone who knew better. It is stored as such, against
// the finding, with who said it.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess, ipOf, uaOf,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum, boundedString } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { logEvent } from './_lib/safelog.mjs'
import { preUnderwritingEnabled } from './_lib/documentIntake.mjs'
import {
  listExtractions, listFindings, listAuthorizations, listDocuments, newId,
} from './_lib/preUnderwritingRepo.mjs'
import { reanalyse, NOT_MEANING } from './pre-underwriting-intake.mjs'
import { buildAnalysisContext, checklistFor } from '../../src/features/pre-underwriting/analysisContext.js'
import { groupParts } from '../../src/features/pre-underwriting/extractionContract.js'
import { loanReadiness, borrowerRequests } from '../../src/features/pre-underwriting/readiness.js'
import { programFit } from '../../src/features/pre-underwriting/programFit.js'
import { qualifyingFacts } from '../../src/features/pre-underwriting/qualifyingFacts.js'
import {
  creditPullAllowed, authorizationGap, CREDIT_AUTHORIZATION, CREDIT_AUTH_VERSION,
} from '../../src/features/pre-underwriting/creditAuthorization.js'
import { getDocumentType } from '../../src/features/pre-underwriting/documentCatalog.js'

const ACTIONS = ['confirm', 'correct', 'dismiss', 'reanalyse']

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!preUnderwritingEnabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const isPost = req.method === 'POST'
  let body = {}
  let loanFileId
  if (isPost) {
    const parsed = await readJsonBody(req)
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
    body = parsed.body
    loanFileId = body.loanFileId
  } else if (req.method === 'GET') {
    loanFileId = new URL(req.url).searchParams.get('loanFileId')
  } else {
    return json({ ok: false, error: 'Method not allowed' }, 405)
  }
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  const correlationId = newId()
  try {
    if (!isPost) {
      return json(await panel(svc, { loanFile, req, auth }))
    }

    const action = isEnum(body.action, ACTIONS) ? body.action : null
    if (!action) return json({ ok: false, error: 'Invalid action' }, 400)
    if (!isValidIdempotencyKey(body.idempotencyKey)) {
      return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
    }

    if (action === 'reanalyse') {
      const result = await reanalyse(svc, { loanFile, application: await applicationFacts(svc, loanFile), correlationId })
      await logAccess(svc, {
        portalUser: auth.user.id, loanFileId: loanFile.id,
        action: 'pre_underwriting_reanalyse', target: correlationId, req,
      })
      return json({ ok: true, result, ...(await panel(svc, { loanFile, req, auth })) })
    }

    if (!isUuid(body.findingId)) return json({ ok: false, error: 'Invalid findingId' }, 400)

    const { data: existing } = await svc
      .from('pre_underwriting_findings')
      .select('id, loan_file_id, rule, status')
      .eq('id', body.findingId)
      .maybeSingle()
    if (!existing || existing.loan_file_id !== loanFile.id) {
      return json({ ok: false, error: 'Finding not found' }, 404)
    }
    if (existing.status !== 'pending_review') {
      // Already decided. Not an error worth alarming anyone about — two processors opened the
      // same queue — but it must not silently overwrite the first decision.
      return json({ ok: false, error: 'Someone has already reviewed this one.', code: 'already_reviewed' }, 409)
    }

    const status = { confirm: 'confirmed', correct: 'corrected', dismiss: 'dismissed' }[action]
    const note = boundedString(body.note, 1000)
    // A dismissal with no reason is the one that cannot be defended later. Confirming needs no
    // explanation — the finding already is one.
    if (action === 'dismiss' && !note) {
      return json({ ok: false, error: 'Say why this is not an issue on this file.' }, 400)
    }

    const corrections = validCorrections(body.correctedFields)
    if (action === 'correct' && corrections.length === 0) {
      return json({ ok: false, error: 'A correction needs the corrected value.' }, 400)
    }

    const { error: uErr } = await svc
      .from('pre_underwriting_findings')
      .update({
        status,
        resolved_by: auth.user.id,
        resolved_at: new Date().toISOString(),
        resolution_note: note,
        corrected_fields: corrections.length ? corrections : null,
      })
      .eq('id', existing.id)
      .eq('status', 'pending_review')   // lost race ⇒ zero rows, first decision stands
    if (uErr) throw new Error('resolution write: ' + uErr.message)

    logEvent('pu.finding.resolved', {
      severity: 'info', requestId: correlationId, rule: existing.rule, status,
      corrected: corrections.length,
    })
    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId: loanFile.id,
      action: 'pre_underwriting_resolve', target: `${existing.rule}:${status}`, req,
    })

    return json({ ok: true, result: { findingId: existing.id, status }, ...(await panel(svc, { loanFile, req, auth })) })
  } catch (e) {
    logEvent('pu.review.error', { severity: 'error', requestId: correlationId, message: e?.message })
    return json({ ok: false, error: 'Could not complete that.', requestId: correlationId }, 500)
  }
}

/**
 * The whole panel, assembled from the pure layers.
 *
 * Nothing is computed here that a pure module could compute — this only fetches and arranges, so
 * the numbers on the screen are the same ones the tests exercise.
 */
async function panel(svc, { loanFile, req, auth }) {
  const [extractions, findings, authorizations, documents] = await Promise.all([
    listExtractions(svc, loanFile.id),
    listFindings(svc, loanFile.id),
    listAuthorizations(svc, loanFile.id),
    listDocuments(svc, loanFile.id),
  ])

  const application = await applicationFacts(svc, loanFile)
  const ctx = buildAnalysisContext({ extractions, application })
  const checklist = checklistFor({
    purpose: loanFile.loan_purpose || loanFile.purpose,
    program: loanFile.program,
    selfEmployed: application.selfEmployed,
    hasRentalIncome: application.hasRentalIncome,
  })
  const byType = groupParts(extractions)

  const readiness = loanReadiness({
    checklist, byType, findings, extractions: ctx.extractions,
  })

  // The four numbers everything downstream turns on, derived from what was READ rather than
  // from the application alone. Without this the program list runs on an empty file and cheerfully
  // reports that every program fits — which is what it did until a smoke test said so out loud.
  const facts = qualifyingFacts(ctx, application)

  const credit = creditPullAllowed(authorizations)
  const creditGap = authorizationGap({ authorizations })

  // Documents uploaded but never read. Named explicitly: silently omitting them would make the
  // panel claim a completeness it has not actually checked.
  const unread = documents
    .filter((d) => d.storage_path && !extractions.some((e) => e.documentId === d.id))
    .map((d) => ({ id: d.id, docKey: d.doc_key, label: d.label }))

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId: loanFile.id,
    action: 'pre_underwriting_panel', target: loanFile.id, req,
  })

  return {
    ok: true,
    readiness,
    // Split by who can act. A processor chasing a borrower for a credit report is a wasted day,
    // and a borrower asked for one is a borrower who cannot comply.
    missing: {
      borrower: borrowerRequests(checklist, byType),
      loanTeam: readiness.blockers.filter((b) => b.kind === 'document' && b.owner === 'loan_team'),
    },
    findings: findings.map((f) => ({
      ...f,
      // Which document to open. The single most-clicked thing on a panel like this.
      documents: f.sourceDocuments
        .map((k) => ({ docKey: k, label: getDocumentType(k)?.label || k }))
        .filter((d) => d.docKey !== 'application'),
    })),
    // Shown on the panel with its own provenance. A processor who cannot see where a DTI came
    // from has to recompute it by hand, which is the work this was supposed to remove.
    facts,
    programs: programFit({
      creditScore: facts.creditScore.score,
      ltv: facts.ltv.percent,
      dti: facts.dti.percent,
      loanAmount: application.loanAmount,
      veteran: application.veteran,
      selfEmployed: application.selfEmployed,
    }),
    credit: {
      authorized: credit.ok,
      reason: credit.reason,
      expiresAt: credit.expiresAt ? new Date(credit.expiresAt).toISOString() : null,
      gap: creditGap,
      documentVersion: CREDIT_AUTH_VERSION,
      // Sent so the panel can show the loan officer exactly what the borrower will be asked to
      // accept, rather than describing it secondhand.
      text: CREDIT_AUTHORIZATION,
    },
    unread,
    extractions: extractions.map((e) => ({
      id: e.id, documentId: e.documentId, docKey: e.docKey, proposedDocKey: e.proposedDocKey,
      docKeyConfidence: e.docKeyConfidence, docKeyMismatch: e.docKeyMismatch, legible: e.legible,
      fieldCount: e.fields.length, tradelineCount: e.tradelines.length,
      minFieldConfidence: e.minFieldConfidence, needsHumanReview: e.needsHumanReview,
      reviewReasons: e.reviewReasons, createdAt: e.createdAt,
      // Values, so a reviewer can check a reading without downloading the document. Identity and
      // credit documents are excluded by NEVER_ECHOED upstream of any borrower-facing surface;
      // this response is internal and never reaches one.
      fields: e.fields,
    })),
    notMeaning: NOT_MEANING,
    audience: 'team',
  }
}

/**
 * What the borrower said about themselves, from the 1003.
 *
 * Tolerant of the application not existing: pre-underwriting has to work on a file where
 * documents arrived before anyone started the interview, which is the common case for a broker
 * who was emailed a folder.
 */
async function applicationFacts(svc, loanFile) {
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
  const value = (path) => {
    const row = (state || []).find((s) => s.field_path === path)
    const v = row?.normalized_value
    return v && typeof v === 'object' && 'value' in v ? v.value : v
  }

  return {
    monthlyIncome: value('parties[0].income.monthlyEquivalent') ?? value('parties[0].income.amount'),
    employmentStartDate: value('parties[0].employment.startDate'),
    selfEmployed: value('parties[0].employment.selfEmployed') === true,
    loanAmount: value('loan.amount'),
    veteran: value('parties[0].militaryService'),
    liabilities: [],
  }
}

/** Corrected values, bounded and scalar. A free-form object here would be an unvalidated write. */
function validCorrections(input) {
  if (!Array.isArray(input)) return []
  return input
    .slice(0, 20)
    .filter((c) => c && typeof c === 'object' && typeof c.field === 'string')
    .filter((c) => c.value == null || typeof c.value !== 'object')
    .map((c) => ({
      field: c.field.slice(0, 120),
      value: c.value == null ? null : String(c.value).slice(0, 300),
      docKey: typeof c.docKey === 'string' ? c.docKey.slice(0, 60) : null,
    }))
}
