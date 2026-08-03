// GET /.netlify/functions/application-session?loanFileId=…   (borrower-authed, Bearer JWT)
//
// Returns everything the assistant screen needs to render or resume: the next question, the
// captured-value review, progress, and "since your last visit". Creates the application and
// the caller's party row on first visit.
//
// SECURITY
//   • Feature-flagged off by default (CONVERSATIONAL_1003_ENABLED).
//   • The caller must be a borrower/co-borrower participant on THIS loan file, or internal
//     (owner/team). Realtors, escrow, and title are structurally excluded — canSeeFinancials.
//   • No application data is ever returned for a loan file the caller cannot see, and the
//     loanFileId is never trusted as proof of anything.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials, logAccess,
} from './_lib/portal.mjs'
import { isUuid } from './_lib/requestGuard.mjs'
import { conversational1003Enabled } from './_lib/conversational1003.mjs'
import {
  ensureApplication, ensureParty, ensurePartyByIndex, listParties, loadState, currentMonth,
} from './_lib/applicationRepo.mjs'
import { planNextQuestion } from '../../src/features/conversational-1003/questionPlanner.js'
import { computeCompleteness } from '../../src/features/conversational-1003/completenessEngine.js'
import { buildReview } from '../../src/features/conversational-1003/review.js'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!conversational1003Enabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const url = new URL(req.url)
  const loanFileId = url.searchParams.get('loanFileId')
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    console.error('[application-session] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || !canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  const internal = isInternal(access)
  const locale = url.searchParams.get('locale') || 'en'

  // A team member taking the application over the phone needs the same next question the
  // borrower would get. Opt-in per request rather than implied by being internal: reviewing a
  // file and conducting an interview are different acts, and the screen has to have chosen one.
  const assistRaw = url.searchParams.get('assistParty')
  const assistParty = internal && (assistRaw === '0' || assistRaw === '1') ? Number(assistRaw) : null

  try {
    const application = await ensureApplication(svc, {
      loanFile, createdBy: auth.user.id, locale,
    })
    // Internal viewers read the borrower's application; they do not become a party to it. Taking
    // it on someone's behalf opens that person's seat — still without an account behind it.
    const party = !internal
      ? await ensureParty(svc, {
        application, loanFile, userId: auth.user.id, visibility: access.visibility, locale,
      })
      : (assistParty !== null
        ? await ensurePartyByIndex(svc, { application, loanFile, partyIndex: assistParty, locale })
        : null)
    const parties = await listParties(svc, application.id)
    const state = await loadState(svc, {
      application, partyCount: Math.max(1, parties.length),
    })

    const asOfMonth = currentMonth()
    const askedHistory = party?.asked_history || {}
    const attested = application.status === 'borrower_attested' || application.status === 'accepted_into_loan_file'
    const report = computeCompleteness(state, { asOfMonth, attested, teamAccepted: application.status === 'accepted_into_loan_file' })
    const nextQuestion = (internal && assistParty === null) ? null : planNextQuestion(state, {
      asOfMonth, locale, askedHistory, attested,
      teamAccepted: application.status === 'accepted_into_loan_file',
    })

    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId, action: 'application_session', target: application.id, req,
    })

    return json({
      ok: true,
      application: {
        id: application.id,
        status: application.status,
        locale: application.locale,
        schemaVersion: application.schema_version,
        catalogVersion: application.catalog_version,
      },
      party: party ? { id: party.id, index: party.party_index, role: party.party_role } : null,
      // Whose application this is, and whether the caller is the one filling it out. The screen
      // needs both to avoid ever implying a team member is answering about themselves.
      assisting: assistParty === null ? null : {
        partyIndex: assistParty,
        role: assistParty === 1 ? 'coborrower' : 'borrower',
        borrowerName: loanFile.borrower_name || null,
        // A team member cannot attest. Said here rather than discovered at the end of an
        // interview, when the only remaining move would be to start over as someone else.
        canAttest: false,
      },
      nextQuestion,
      review: buildReview(state, report, { locale }),
      progress: {
        percent: report.percent,
        status: report.status,
        openCount: report.openFields.length + report.structural.length,
        conflictCount: report.conflicts.length,
        meaning: report.meaning,
        notMeaning: report.notMeaning,
      },
      // Never true for a team member, however complete the application is. Attesting is the
      // borrower's act; application-attest refuses them regardless, and offering the button
      // would only produce a 403 at the one moment the work looked finished.
      canAttest: !internal && report.everythingResolved && !attested,
    })
  } catch (e) {
    console.error('[application-session]', e?.message || e)
    return json({ ok: false, error: 'Could not load your application' }, 500)
  }
}
