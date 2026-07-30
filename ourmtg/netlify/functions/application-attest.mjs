// POST /.netlify/functions/application-attest   (borrower-authed, Bearer JWT)
//
// The borrower's final review and attestation (§6.J, §13). Two hard rules:
//   • The gate is DETERMINISTIC — canAttest() must be true. No model, and no client claim,
//     can open it while a required field is unresolved.
//   • This is an ATTESTATION, not an electronic signature. A conversational "yes" is never
//     treated as e-sign; that remains a separate, approved workflow.
//
// Attesting means: "the information I gave is complete and accurate." It does not mean
// approved, pre-approved, verified, underwritten, submitted to an AUS, or cleared to close.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, logAccess, ipOf, uaOf,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { conversational1003Enabled } from './_lib/conversational1003.mjs'
import {
  ensureApplication, ensureParty, listParties, loadState, updateApplication, currentMonth,
} from './_lib/applicationRepo.mjs'
import { computeCompleteness, canAttest } from '../../src/features/conversational-1003/completenessEngine.js'
import { buildReview } from '../../src/features/conversational-1003/review.js'
import { ATTESTATION, ATTESTATION_VERSION } from '../../src/features/conversational-1003/attestationText.js'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!conversational1003Enabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body

  if (!isUuid(body.loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  if (!isValidIdempotencyKey(body.idempotencyKey)) {
    return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
  }
  // The client must echo the exact text version it displayed, so we can prove what was shown.
  if (body.documentVersion !== ATTESTATION_VERSION) {
    return json({ ok: false, error: 'Please reload and review the current statement.' }, 409)
  }
  if (body.accepted !== true) return json({ ok: false, error: 'Attestation was not accepted' }, 400)
  if (!body.presentedAt || Number.isNaN(Date.parse(body.presentedAt))) {
    return json({ ok: false, error: 'Invalid presentation timestamp' }, 400)
  }
  const locale = isEnum(body.locale, ['en', 'es', 'ru']) ? body.locale : 'en'

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, body.loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || !['borrower', 'coborrower'].includes(access.visibility)) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  try {
    const application = await ensureApplication(svc, { loanFile, createdBy: auth.user.id, locale })
    const party = await ensureParty(svc, {
      application, loanFile, userId: auth.user.id, visibility: access.visibility, locale,
    })
    const parties = await listParties(svc, application.id)
    const state = await loadState(svc, { application, partyCount: Math.max(1, parties.length) })
    const asOfMonth = currentMonth()
    const report = computeCompleteness(state, { asOfMonth })

    // The gate. Everything the borrower still owes is enumerated back to them.
    if (!canAttest(report)) {
      return json({
        ok: false,
        error: 'There are still items to finish before you can submit.',
        openItems: [
          ...report.openFields.map((o) => ({ kind: 'field', path: o.path, section: o.section })),
          ...report.structural.map((s) => ({ kind: s.kind, section: s.group })),
          ...report.conflicts.map((c) => ({ kind: 'conflict', path: c.path, section: c.section })),
        ],
      }, 409)
    }

    const acceptedAt = new Date().toISOString()
    const snapshot = {
      fields: Object.fromEntries(Object.entries(state.fields).map(([p, v]) => [p, {
        value: v.normalized_value, display: v.display_value, status: v.status,
        source: v.source, estimated: v.estimated,
      }])),
      schemaVersion: state.schemaVersion,
    }

    const { error: aErr } = await svc.from('application_attestations').insert({
      application_id: application.id,
      party_id: party.id,
      organization_id: loanFile.organization_id || null,
      loan_file_id: loanFile.id,
      document_key: 'borrower_application_attestation',
      document_version: ATTESTATION_VERSION,
      presented_at: new Date(body.presentedAt).toISOString(),
      accepted_at: acceptedAt,
      accepted_by: auth.user.id,
      application_snapshot: snapshot,
      completeness_snapshot: {
        percent: report.percent, totalRequired: report.totalRequired,
        resolvedRequired: report.resolvedRequired, meaning: report.meaning,
      },
      // Recorded per the approved privacy policy; UA truncated by uaOf.
      ip: ipOf(req),
      user_agent: uaOf(req),
    })
    if (aErr) throw new Error('attestation write: ' + aErr.message)

    await updateApplication(svc, application.id, {
      status: 'borrower_attested', percent_complete: report.percent,
    })
    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId: loanFile.id, action: 'application_attested',
      target: ATTESTATION_VERSION, req,
    })

    return json({
      ok: true,
      status: 'borrower_attested',
      attestedAt: acceptedAt,
      review: buildReview(state, report, { locale }),
      // Stated plainly so no screen can imply a decision was made.
      meaning: report.meaning,
      notMeaning: report.notMeaning,
      nextStep: NEXT_STEP[locale] || NEXT_STEP.en,
    })
  } catch (e) {
    console.error('[application-attest]', e?.message || e)
    return json({ ok: false, error: 'Could not submit your application. Please try again.' }, 500)
  }
}

const NEXT_STEP = {
  en: 'Your loan team will review what you provided and follow up with any questions. This is not an approval or a commitment to lend.',
  es: 'Su equipo revisará la información y le contactará si tiene preguntas. Esto no es una aprobación ni un compromiso de préstamo.',
  ru: 'Ваша кредитная команда проверит информацию и свяжется с вами при вопросах. Это не одобрение и не обязательство выдать кредит.',
}

export { ATTESTATION }
