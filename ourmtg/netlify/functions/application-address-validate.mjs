// POST /.netlify/functions/application-address-validate
// Authenticated property-address verification and explicit acceptance of a provider suggestion.
// The browser never sends the address to validate: the server reads the reducer state, calls
// Google with a server-only key, and remains the only writer of corrected structured values.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'
import { conversational1003Enabled } from './_lib/conversational1003.mjs'
import {
  ensureApplication, ensureParty, ensurePartyByIndex, listParties, loadState, persistEvents,
  syncProjection, claimTurn, updateTurn, updateApplication, currentMonth, newId,
} from './_lib/applicationRepo.mjs'
import {
  propertyAddressFromState, validatePropertyAddress,
} from './_lib/addressValidation.mjs'
import { recordValue } from '../../src/features/conversational-1003/applicationReducer.js'
import { computeCompleteness } from '../../src/features/conversational-1003/completenessEngine.js'
import { planNextQuestion } from '../../src/features/conversational-1003/questionPlanner.js'
import { buildReview } from '../../src/features/conversational-1003/review.js'

const ACTIONS = ['validate', 'accept_suggestion']
const TAKEN_VIA = ['phone', 'in_person', 'video']
const PATH_BY_KEY = Object.freeze({
  street: 'loan.propertyStreet',
  city: 'loan.propertyCity',
  state: 'loan.propertyState',
  postalCode: 'loan.propertyPostalCode',
})

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
  const action = isEnum(body.action, ACTIONS) ? body.action : null
  if (!action) return json({ ok: false, error: 'Invalid action' }, 400)
  if (action === 'accept_suggestion' && !isValidIdempotencyKey(body.idempotencyKey)) {
    return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
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
  const borrowerSide = Boolean(access) && ['borrower', 'coborrower'].includes(access.visibility)
  const teamSide = isInternal(access)
  if (!borrowerSide && !teamSide) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  const assistPartyIndex = borrowerSide ? null
    : (body.assistParty === 0 || body.assistParty === 1 ? body.assistParty : null)
  if (!borrowerSide && assistPartyIndex === null) {
    return json({ ok: false, error: 'Say whose application you are entering.' }, 400)
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
      : await ensurePartyByIndex(svc, {
        application, loanFile, partyIndex: assistPartyIndex, locale,
      })
    const parties = await listParties(svc, application.id)
    const partyCount = Math.max(1, parties.length)
    let state = await loadState(svc, { application, partyCount })
    const address = propertyAddressFromState(state)
    if (!address) return json({ ok: true, addressValidation: { status: 'incomplete' } })

    const check = await validatePropertyAddress(address)
    if (action === 'validate') {
      return json({ ok: true, addressValidation: check })
    }
    if (check.status !== 'suggestion') {
      return json({ ok: false, error: 'That suggested address is no longer available.' }, 409)
    }

    const rHash = requestHash({ action, responseId: check.responseId, party: party.id })
    const claim = await claimTurn(svc, {
      application, party, loanFile,
      idempotencyKey: body.idempotencyKey,
      requestHash: rHash,
      fields: {
        direction: 'in', input_mode: 'control', locale, intent: action,
        asked_field_path: 'loan.propertyStreet',
        taken_by: borrowerSide ? null : auth.user.id,
        taken_via: borrowerSide ? null : (isEnum(body.takenVia, TAKEN_VIA) ? body.takenVia : null),
      },
    })
    if (claim.conflict) return json({ ok: false, error: 'That action was already used differently.' }, 409)

    if (!claim.created) {
      const report = computeCompleteness(state, { asOfMonth: currentMonth() })
      return json({
        ok: true, deduped: true, addressValidation: { ...check, status: 'verified' },
        nextQuestion: planNextQuestion(state, {
          asOfMonth: currentMonth(), locale, askedHistory: party.asked_history || {},
        }),
        review: buildReview(state, report, { locale }), progress: progressOf(report),
      })
    }

    const at = new Date().toISOString()
    const before = state.events.length
    for (const [key, path] of Object.entries(PATH_BY_KEY)) {
      const r = recordValue(state, {
        path,
        rawValue: check.suggested[key],
        originalText: '',
        source: borrowerSide ? 'borrower_secure_input' : 'team_entry',
        turnId: claim.turn.id,
        at,
        eventId: newId(),
        isCorrection: true,
        actor: auth.user.id,
      })
      if (r.outcome === 'rejected') throw new Error('provider returned an unusable address component')
      state = r.state
    }

    const newEvents = state.events.slice(before)
    if (newEvents.length) {
      await persistEvents(svc, { application, party, loanFile, events: newEvents, turnId: claim.turn.id })
      await syncProjection(svc, {
        application, party, loanFile, state, paths: newEvents.map((e) => e.field_path),
      })
    }
    await updateTurn(svc, claim.turn.id, {
      processing_state: 'interpreted', interpreted_at: at, provider_name: 'google_address_validation',
    })
    const report = computeCompleteness(state, { asOfMonth: currentMonth() })
    await updateApplication(svc, application.id, {
      status: report.status, percent_complete: report.percent,
    })
    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId: loanFile.id,
      action: borrowerSide ? 'application_address_corrected' : 'application_address_corrected_assisted',
      target: application.id, req,
    })
    return json({
      ok: true,
      addressValidation: { ...check, status: 'verified' },
      nextQuestion: planNextQuestion(state, {
        asOfMonth: currentMonth(), locale, askedHistory: party.asked_history || {},
      }),
      review: buildReview(state, report, { locale }),
      progress: progressOf(report),
      canAttest: borrowerSide && report.everythingResolved,
    })
  } catch (e) {
    // Never log the address or upstream response: both contain borrower/property PII.
    console.error('[application-address-validate]', e?.name || 'address validation failed')
    return json({ ok: false, error: 'Could not verify that address. Please try again.' }, 500)
  }
}

const progressOf = (r) => ({
  percent: r.percent, status: r.status,
  openCount: r.openFields.length + r.structural.length,
  conflictCount: r.conflicts.length,
  meaning: r.meaning, notMeaning: r.notMeaning,
})
