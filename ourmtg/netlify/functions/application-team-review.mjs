// GET  /.netlify/functions/application-team-review?loanFileId=…   (internal-only)
// POST /.netlify/functions/application-team-review                (internal-only)
//
// The loan team's view of a borrower's application, plus the team actions from §19.
// Internal = loan-file owner or portal_team member. Borrowers, realtors, escrow, and title
// never reach this endpoint.
//
// Team edits NEVER erase borrower history: a team correction appends a `team_entry` event that
// supersedes the prior value, and the borrower's original wording stays in the log.
//
// POST body: { loanFileId, idempotencyKey, action, fieldPath?, value?, note? }
//   action = 'request_clarification' | 'correct' | 'confirm_reviewed'
//          | 'mark_not_applicable' | 'return_to_borrower' | 'accept_into_loan_file'

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum, boundedString } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { conversational1003Enabled } from './_lib/conversational1003.mjs'
import {
  ensureApplication, listParties, loadState, persistEvents, syncProjection, listTurns,
  updateApplication, currentMonth, newId,
} from './_lib/applicationRepo.mjs'
import {
  recordValue, confirmValue, markNotApplicable, flagClarification,
} from '../../src/features/conversational-1003/applicationReducer.js'
import { computeCompleteness } from '../../src/features/conversational-1003/completenessEngine.js'
import { buildTeamReview, partyProgress, confusionFlags } from '../../src/features/conversational-1003/review.js'
import { isKnownField, getField } from '../../src/features/conversational-1003/applicationCatalog.js'

const ACTIONS = [
  'request_clarification', 'correct', 'confirm_reviewed', 'mark_not_applicable',
  'return_to_borrower', 'accept_into_loan_file',
]

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!conversational1003Enabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const svc = admin()
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

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  try {
    const application = await ensureApplication(svc, { loanFile, createdBy: auth.user.id })
    const parties = await listParties(svc, application.id)
    const partyCount = Math.max(1, parties.length)
    let state = await loadState(svc, { application, partyCount })
    const asOfMonth = currentMonth()

    if (!isPost) {
      const report = computeCompleteness(state, {
        asOfMonth,
        attested: ['borrower_attested', 'accepted_into_loan_file'].includes(application.status),
        teamAccepted: application.status === 'accepted_into_loan_file',
      })
      const turns = await listTurns(svc, application.id, { limit: 100 })
      await logAccess(svc, {
        portalUser: auth.user.id, loanFileId, action: 'application_team_review', target: application.id, req,
      })
      return json({
        ok: true,
        application: {
          id: application.id, status: application.status, locale: application.locale,
          schemaVersion: application.schema_version, catalogVersion: application.catalog_version,
          rulesVersion: application.rules_version, percent: application.percent_complete,
        },
        review: buildTeamReview(state, report, { parties }),
        // Separate progress per party (§19) — never a single blended number.
        partyProgress: parties.map((p) => ({
          ...partyProgress(report, p.party_index),
          role: p.party_role,
          confusion: confusionFlags(p.asked_history || {}),
        })),
        history: turns.map((t) => ({
          id: t.id, at: t.created_at, direction: t.direction, mode: t.input_mode,
          intent: t.intent, relevance: t.answer_relevance, misunderstanding: t.misunderstanding,
          state: t.processing_state, askedField: t.asked_field_path,
          safetyFlags: t.safety_flags, provider: t.provider_name, model: t.provider_model,
          // Scrubbed of SSNs and account numbers at the endpoint boundary, before the row was
          // ever written — see application-turn. Until 2026-08 that claim was made here and was
          // untrue: the turn row is persisted before interpretation runs, so the engine's
          // redaction came too late to protect it.
          text: t.borrower_text,
          // Null when the party answered for themselves. Set when the loan team took it down,
          // so the transcript never reads as the borrower's own typing.
          takenBy: t.taken_by || null,
          takenVia: t.taken_via || null,
        })),
      })
    }

    // ── Team actions ────────────────────────────────────────────────────────
    const action = isEnum(body.action, ACTIONS) ? body.action : null
    if (!action) return json({ ok: false, error: 'Invalid action' }, 400)
    if (!isValidIdempotencyKey(body.idempotencyKey)) {
      return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
    }

    const at = new Date().toISOString()
    const before = state.events.length
    let result = { action }

    if (['request_clarification', 'correct', 'confirm_reviewed', 'mark_not_applicable'].includes(action)) {
      const fieldPath = body.fieldPath
      if (typeof fieldPath !== 'string' || !isKnownField(fieldPath)) {
        return json({ ok: false, error: 'Unknown field' }, 400)
      }
      const field = getField(fieldPath)
      // A secure value can never be set or read through the team endpoint (§19: masked only).
      if (field.secureEntry) return json({ ok: false, error: 'Secure fields cannot be edited here' }, 400)

      if (action === 'correct') {
        const r = recordValue(state, {
          path: fieldPath, rawValue: body.value, source: 'team_entry', at,
          eventId: newId(), actor: auth.user.id, isCorrection: true,
        })
        if (r.outcome === 'rejected') return json({ ok: false, error: 'That value could not be read' }, 400)
        state = r.state
        result = { action, path: fieldPath, outcome: r.outcome }
      } else if (action === 'confirm_reviewed') {
        const r = confirmValue(state, { path: fieldPath, at, eventId: newId(), actor: auth.user.id, byTeam: true })
        if (!r.event) return json({ ok: false, error: r.reason || 'Nothing to confirm' }, 400)
        state = r.state
        result = { action, path: fieldPath, outcome: r.outcome }
      } else if (action === 'mark_not_applicable') {
        const r = markNotApplicable(state, {
          path: fieldPath, ruleId: `team:${boundedString(body.note, 200) || 'manual'}`,
          at, eventId: newId(), actor: auth.user.id,
        })
        state = r.state
        result = { action, path: fieldPath, outcome: r.outcome }
      } else {
        const r = flagClarification(state, {
          path: fieldPath, reason: boundedString(body.note, 500) || 'team_requested_clarification',
          at, eventId: newId(),
        })
        if (!r.event) return json({ ok: false, error: 'Nothing to clarify' }, 400)
        state = r.state
        result = { action, path: fieldPath, outcome: r.outcome }
      }

      const newEvents = state.events.slice(before)
      if (newEvents.length) {
        await persistEvents(svc, {
          application, party: null, loanFile, events: newEvents, turnId: null,
        })
        await syncProjection(svc, {
          application, party: null, loanFile, state, paths: newEvents.map((e) => e.field_path),
        })
      }
    }

    const report = computeCompleteness(state, {
      asOfMonth,
      attested: ['borrower_attested', 'accepted_into_loan_file'].includes(application.status),
      teamAccepted: application.status === 'accepted_into_loan_file',
    })

    if (action === 'return_to_borrower') {
      await updateApplication(svc, application.id, { status: 'returned_for_clarification' })
      result = { action, status: 'returned_for_clarification' }
    } else if (action === 'accept_into_loan_file') {
      // Accepting collected information into the file is a human act with a human precondition:
      // the borrower must have attested first. It is still not an underwriting decision.
      if (application.status !== 'borrower_attested') {
        return json({ ok: false, error: 'The borrower has not submitted the application yet.' }, 409)
      }
      await updateApplication(svc, application.id, { status: 'accepted_into_loan_file' })
      result = { action, status: 'accepted_into_loan_file' }
    } else {
      await updateApplication(svc, application.id, {
        status: report.status, percent_complete: report.percent,
      })
    }

    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId, action: 'application_team_action', target: action, req,
    })
    return json({ ok: true, result, review: buildTeamReview(state, report, { parties }) })
  } catch (e) {
    console.error('[application-team-review]', e?.message || e)
    return json({ ok: false, error: 'Could not complete that action.' }, 500)
  }
}
