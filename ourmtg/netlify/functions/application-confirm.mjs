// POST /.netlify/functions/application-confirm   (borrower- or team-authed, Bearer JWT)
//
// The "Correct / Change it / I'm not sure" action (§14), plus contradiction resolution (§28.14)
// and permitted refusals (§28.11). Deliberately separate from application-turn: confirming a
// value is a structured act, not a sentence for a language model to interpret.
//
// Body: { loanFileId, idempotencyKey, action, fieldPath?, paths?[], chosenValue? }
//   action = 'confirm' | 'resolve_conflict' | 'decline' | 'unsure'

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum, boundedString } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'
import { conversational1003Enabled } from './_lib/conversational1003.mjs'
import {
  ensureApplication, ensureParty, ensurePartyByIndex, listParties, loadState, persistEvents,
  syncProjection, claimTurn, updateTurn, updateApplication, saveAskedHistory, currentMonth, newId,
} from './_lib/applicationRepo.mjs'
import {
  confirmValue, resolveConflict, declineField, flagClarification,
} from '../../src/features/conversational-1003/applicationReducer.js'
import { computeCompleteness } from '../../src/features/conversational-1003/completenessEngine.js'
import { planNextQuestion, noteSkipped } from '../../src/features/conversational-1003/questionPlanner.js'
import { buildReview } from '../../src/features/conversational-1003/review.js'
import { isKnownField } from '../../src/features/conversational-1003/applicationCatalog.js'

const ACTIONS = ['confirm', 'resolve_conflict', 'decline', 'unsure']
const TAKEN_VIA = ['phone', 'in_person', 'video']

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
  const action = isEnum(body.action, ACTIONS) ? body.action : null
  if (!action) return json({ ok: false, error: 'Invalid action' }, 400)

  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 25) : (body.fieldPath ? [body.fieldPath] : [])
  if (!paths.length) return json({ ok: false, error: 'Nothing to confirm' }, 400)
  // Every path must be a real catalog field; an unknown path is never "just ignored".
  if (!paths.every((p) => typeof p === 'string' && isKnownField(p))) {
    return json({ ok: false, error: 'Unknown field' }, 400)
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

  // Same two callers as application-turn: the borrower, or the loan team taking the application
  // on their behalf. Splitting these two endpoints on authorization would give a team member an
  // interview whose confirmation buttons all fail.
  const borrowerSide = Boolean(access) && ['borrower', 'coborrower'].includes(access.visibility)
  const teamSide = isInternal(access)
  if (!borrowerSide && !teamSide) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }
  let assistPartyIndex = null
  if (!borrowerSide) {
    assistPartyIndex = body.assistParty === 1 ? 1 : (body.assistParty === 0 ? 0 : null)
    if (assistPartyIndex === null) {
      return json({ ok: false, error: 'Say whether you are entering this for the borrower or the co-borrower.' }, 400)
    }
  }

  try {
    const application = await ensureApplication(svc, { loanFile, createdBy: auth.user.id, locale })
    if (['borrower_attested', 'accepted_into_loan_file'].includes(application.status)) {
      return json({ ok: false, error: 'This application has been submitted for review.' }, 409)
    }
    const party = borrowerSide
      ? await ensureParty(svc, {
        application, loanFile, userId: auth.user.id, visibility: access.visibility, locale,
      })
      : await ensurePartyByIndex(svc, { application, loanFile, partyIndex: assistPartyIndex, locale })
    const parties = await listParties(svc, application.id)
    const partyCount = Math.max(1, parties.length)

    const rHash = requestHash({ action, paths, chosenValue: body.chosenValue ?? null, party: party.id })
    const claim = await claimTurn(svc, {
      application, party, loanFile,
      idempotencyKey: body.idempotencyKey,
      requestHash: rHash,
      fields: {
        direction: 'in', input_mode: 'control', locale, intent: action,
        asked_field_path: boundedString(paths[0], 200),
        taken_by: borrowerSide ? null : auth.user.id,
        taken_via: borrowerSide ? null : (isEnum(body.takenVia, TAKEN_VIA) ? body.takenVia : null),
      },
    })
    if (claim.conflict) return json({ ok: false, error: 'That key was already used for a different action.' }, 409)

    let state = await loadState(svc, { application, partyCount })
    const asOfMonth = currentMonth()
    let askedHistory = party.asked_history || {}

    if (!claim.created) {
      const report = computeCompleteness(state, { asOfMonth })
      return json({
        ok: true, deduped: true,
        nextQuestion: planNextQuestion(state, { asOfMonth, locale, askedHistory }),
        review: buildReview(state, report, { locale }),
        progress: progressOf(report),
      })
    }

    const at = new Date().toISOString()
    const before = state.events.length
    const results = []

    for (const path of paths) {
      let r
      if (action === 'confirm') {
        r = confirmValue(state, { path, at, eventId: newId(), actor: auth.user.id, byTeam: !borrowerSide })
      } else if (action === 'resolve_conflict') {
        r = resolveConflict(state, {
          path, chosenValue: body.chosenValue, at, eventId: newId(), actor: auth.user.id,
        })
      } else if (action === 'decline') {
        r = declineField(state, { path, at, eventId: newId(), actor: auth.user.id })
        // A refusal where refusal is not permitted is NOT an error the borrower should feel —
        // we simply leave the field open and stop asking for now (§26: no repeated pressure).
        if (!r.event) askedHistory = noteSkipped(askedHistory, `field:${path}`, { at })
      } else {
        // 'unsure' — keep the value, flag it for a targeted follow-up rather than accepting it.
        // Who was unsure matters: "the borrower was unsure" and "the person taking it down was
        // unsure" are different follow-ups, and recording the first when the second happened
        // would send someone back to the borrower over a transcription doubt.
        r = flagClarification(state, {
          path, reason: borrowerSide ? 'borrower_unsure' : 'taken_by_team_unsure', at, eventId: newId(),
        })
      }
      if (r.state) state = r.state
      results.push({ path, outcome: r.outcome, reason: r.reason || null })
    }

    const newEvents = state.events.slice(before)
    if (newEvents.length) {
      await persistEvents(svc, { application, party, loanFile, events: newEvents, turnId: claim.turn.id })
      await syncProjection(svc, {
        application, party, loanFile, state, paths: newEvents.map((e) => e.field_path),
      })
    }
    await saveAskedHistory(svc, party.id, askedHistory)
    await updateTurn(svc, claim.turn.id, { processing_state: 'interpreted', interpreted_at: at })

    const report = computeCompleteness(state, { asOfMonth })
    await updateApplication(svc, application.id, {
      status: report.status, percent_complete: report.percent,
    })
    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId: loanFile.id,
      action: borrowerSide ? 'application_confirm' : 'application_confirm_assisted', target: action, req,
    })

    return json({
      ok: true,
      results,
      nextQuestion: planNextQuestion(state, { asOfMonth, locale, askedHistory }),
      review: buildReview(state, report, { locale }),
      progress: progressOf(report),
      // A team member is never offered attestation, however complete the application looks.
      canAttest: borrowerSide && report.everythingResolved,
    })
  } catch (e) {
    console.error('[application-confirm]', e?.message || e)
    return json({ ok: false, error: 'Could not save that. Please try again.' }, 500)
  }
}

const progressOf = (r) => ({
  percent: r.percent, status: r.status,
  openCount: r.openFields.length + r.structural.length,
  conflictCount: r.conflicts.length,
  meaning: r.meaning, notMeaning: r.notMeaning,
})
