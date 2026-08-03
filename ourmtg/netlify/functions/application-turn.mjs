// POST /.netlify/functions/application-turn   (borrower- or team-authed, Bearer JWT)
//
// One turn of the interview. Usually the borrower's own; optionally taken by the loan team on
// their behalf, which is how mortgage applications have been taken over the phone for decades
// and which the URLA has a box for ("This application was taken by: Face-to-Face / Telephone").
//
// A team-taken turn differs from a borrower's in three ways, and all three matter:
//   • the value lands as `team_entry`, never as the borrower's own words
//   • the turn records taken_by + taken_via, so the transcript does not read as if the borrower
//     typed it
//   • it changes nothing about attestation — see application-attest, which still refuses anyone
//     who is not the borrower. The team can collect the information; only the borrower can
//     swear to it.
//
// One borrower turn. The ordering here IS the §24 guarantee and must not be rearranged:
//
//   1. persist the borrower's turn            ← survives everything after this line
//   2. acknowledge durable receipt            ← the idempotency key now owns this turn
//   3. interpret (may time out / fail)
//   4. validate against the strict contract   ← model output is untrusted
//   5. update application state (append-only)
//   6. compute the next question deterministically
//   7. return
//
// If step 3 or 4 fails, the borrower's words are already stored and the deterministic planner
// still produces a next question — the answer is never lost, the interview never dead-ends.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum, boundedString } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey, requestHash } from './_lib/idempotency.mjs'
import { createRateLimiter } from './_lib/ratelimit.mjs'
import { logEvent } from './_lib/safelog.mjs'
import {
  conversational1003Enabled, selectProvider, interpretWithProvider, SYSTEM_PROMPT_VERSION,
} from './_lib/conversational1003.mjs'
import {
  ensureApplication, ensureParty, ensurePartyByIndex, listParties, loadState, persistEvents,
  syncProjection, claimTurn, updateTurn, saveAskedHistory, updateApplication, currentMonth, newId,
} from './_lib/applicationRepo.mjs'
import { processTurn, buildProviderContext } from '../../src/features/conversational-1003/engine.js'
import { validateTurnResponse, redactSensitive } from '../../src/features/conversational-1003/turnContract.js'
import { planNextQuestion } from '../../src/features/conversational-1003/questionPlanner.js'
import { buildReview } from '../../src/features/conversational-1003/review.js'
import { BORROWER_INTENTS, SUPPORTED_LOCALES } from '../../src/features/conversational-1003/types.js'

const MAX_TEXT = 4000

// How the loan team collected the answers. 'self' is not offered: it means the borrower typed
// it themselves, which is the case where nobody is answering on anyone's behalf.
const TAKEN_VIA = ['phone', 'in_person', 'video']

// A dedicated limiter, not the shared one: sharedLimiter() is a process-wide singleton whose
// first caller fixes the window for everyone, and lead-submit's public limits are much tighter
// than what a borrower typing through an interview needs.
const turnLimiter = createRateLimiter({ windowMs: 60_000, max: 60 })

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!conversational1003Enabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req, { maxBytes: 32_000 })
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body

  const loanFileId = body.loanFileId
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  if (!isValidIdempotencyKey(body.idempotencyKey)) {
    return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
  }
  // Scrubbed HERE, not in the engine. The engine redacts too, but it does not run until step 3
  // — and step 1 has already written the turn row durably by then. That row is what the team
  // review screen renders as "their own words", so an SSN read out over the phone and typed in
  // here was persisting and being displayed. Redacting at the boundary makes the guarantee true
  // for every path: what is stored, what reaches the provider, and what the engine sees.
  const text = redactSensitive(boundedString(body.text, MAX_TEXT) || '').text
  const intent = isEnum(body.intent, BORROWER_INTENTS) ? body.intent : 'answer'
  const locale = isEnum(body.locale, SUPPORTED_LOCALES) ? body.locale : 'en'
  const inputMode = isEnum(body.inputMode, ['text', 'voice']) ? body.inputMode : 'text'
  if (intent === 'answer' && !text) return json({ ok: false, error: 'Nothing to record' }, 400)

  // Per-user throughput cap. Conversation is cheap for a person and expensive for us, so the
  // ceiling is generous but present.
  const limited = turnLimiter.check(`c1003:${auth.user.id}`)
  if (!limited.allowed) {
    return json({ ok: false, error: 'Please slow down a moment and try again.' }, 429)
  }

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    console.error('[application-turn] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)

  // Two kinds of caller, and the difference decides everything downstream. Realtors, escrow and
  // title reach neither branch.
  const borrowerSide = Boolean(access) && ['borrower', 'coborrower'].includes(access.visibility)
  const teamSide = isInternal(access)
  if (!borrowerSide && !teamSide) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  // A team member must say who they are answering for and how they collected it. Neither is
  // inferable, and a wrong guess writes a false record — so both are required rather than
  // defaulted.
  let assistPartyIndex = null
  let takenVia = null
  if (!borrowerSide) {
    assistPartyIndex = body.assistParty === 1 ? 1 : (body.assistParty === 0 ? 0 : null)
    if (assistPartyIndex === null) {
      return json({ ok: false, error: 'Say whether you are entering this for the borrower or the co-borrower.' }, 400)
    }
    takenVia = isEnum(body.takenVia, TAKEN_VIA) ? body.takenVia : null
    if (!takenVia) return json({ ok: false, error: 'Record how this application is being taken.' }, 400)
  }

  const correlationId = newId()
  try {
    const application = await ensureApplication(svc, { loanFile, createdBy: auth.user.id, locale })
    if (['borrower_attested', 'accepted_into_loan_file'].includes(application.status)) {
      return json({ ok: false, error: 'This application has been submitted for review.' }, 409)
    }
    // The team member does not become a party to the application they are taking. They fill the
    // borrower's seat; the borrower claims it when they sign in.
    const party = borrowerSide
      ? await ensureParty(svc, {
        application, loanFile, userId: auth.user.id, visibility: access.visibility, locale,
      })
      : await ensurePartyByIndex(svc, { application, loanFile, partyIndex: assistPartyIndex, locale })
    const parties = await listParties(svc, application.id)
    const partyCount = Math.max(1, parties.length)

    // ── 1 + 2: persist the turn, then own it ───────────────────────────────
    const rHash = requestHash({ text, intent, locale, loanFileId, party: party.id })
    const claim = await claimTurn(svc, {
      application, party, loanFile,
      idempotencyKey: body.idempotencyKey,
      requestHash: rHash,
      fields: {
        direction: 'in',
        input_mode: inputMode,
        borrower_text: text || null,
        locale,
        asked_question_id: boundedString(body.askedQuestionId, 200),
        asked_field_path: boundedString(body.askedFieldPath, 200),
        intent,
        prompt_version: SYSTEM_PROMPT_VERSION,
        // null on a borrower's own turn: the party answered for themselves, which is what an
        // absent value has always meant on every row written before this existed.
        taken_by: borrowerSide ? null : auth.user.id,
        taken_via: borrowerSide ? null : takenVia,
      },
    })
    if (claim.conflict) {
      return json({ ok: false, error: 'That key was already used for a different answer.' }, 409)
    }
    if (!claim.created) {
      // Duplicate submit (double-click, mobile retry, refresh). Return the CURRENT view
      // without creating a second field event — scenario 17.
      const state = await loadState(svc, { application, partyCount })
      const asOfMonth = currentMonth()
      const nextQuestion = planNextQuestion(state, {
        asOfMonth, locale, askedHistory: party.asked_history || {},
      })
      return json({
        ok: true, deduped: true, turnId: claim.turn?.id || null,
        nextQuestion, message: null, accepted: [],
        ...summaries(state, nextQuestion, locale, asOfMonth),
      })
    }
    const turnId = claim.turn.id

    // ── 3: interpret (best effort) ─────────────────────────────────────────
    const state = await loadState(svc, { application, partyCount })
    const asOfMonth = currentMonth()
    const askedHistory = party.asked_history || {}
    const askedQuestion = planNextQuestion(state, { asOfMonth, locale, askedHistory })

    let interpretation = null
    let providerMeta = {}
    let degraded = false

    if (intent === 'answer' && text) {
      const sel = selectProvider()
      if (!sel.ok) {
        degraded = true
        logEvent('c1003.provider.unavailable', { severity: 'warn', requestId: correlationId, reason: sel.error })
      } else {
        await updateTurn(svc, turnId, { processing_state: 'processing' })
        const context = buildProviderContext(state, { askedQuestion, locale, asOfMonth })
        const res = await interpretWithProvider(sel.provider, { text, context, correlationId })
        providerMeta = res.meta
        if (res.ok) {
          // ── 4: validate. A response that fails the contract is discarded entirely.
          const validated = validateTurnResponse(res.raw, { askedPath: askedQuestion?.fieldPath || null })
          if (validated.ok) interpretation = validated.value
          else {
            degraded = true
            logEvent('c1003.contract.rejected', {
              severity: 'warn', requestId: correlationId, errors: validated.errors,
              rejected: validated.rejected?.length || 0,
            })
          }
        } else {
          degraded = true
        }
      }
    }

    // ── 5 + 6: deterministic state update and next question ────────────────
    // What the team relays is not the borrower's own wording, however faithfully it was heard.
    // `team_entry` is what makes the review screen able to say "not borrower-stated" — and it
    // is what keeps a phone-taken value distinguishable from one the borrower typed.
    const source = !borrowerSide ? 'team_entry'
      : (inputMode === 'voice' ? 'borrower_voice_transcript' : 'borrower_text')
    const out = processTurn(state, {
      turnId, text, source,
      locale, askedQuestion, interpretation, intent, askedHistory,
      at: new Date().toISOString(), asOfMonth, ids: newId,
      // Stamped only on team-taken values. On a borrower's own turn the party row already says
      // who spoke, and an actor there would read as somebody else having entered it.
      actor: borrowerSide ? null : auth.user.id,
    })

    const newEvents = out.state.events.slice(state.events.length)
    if (newEvents.length) {
      await persistEvents(svc, {
        application, party, loanFile, events: newEvents, turnId,
        meta: { ...providerMeta, promptVersion: SYSTEM_PROMPT_VERSION },
      })
      await syncProjection(svc, {
        application, party, loanFile, state: out.state,
        paths: newEvents.map((e) => e.field_path),
      })
    }
    await saveAskedHistory(svc, party.id, out.askedHistory)
    await updateTurn(svc, turnId, {
      processing_state: degraded ? 'failed_safe' : 'interpreted',
      answer_relevance: interpretation?.answerRelevance || null,
      misunderstanding: out.detection?.kind || null,
      safety_flags: out.safetyFlags || [],
      provider_name: providerMeta.provider || null,
      provider_model: providerMeta.model || null,
      attempts: providerMeta.attempts || 0,
      error_code: degraded
        ? (out.usedDeterministicFallback ? 'deterministic_fallback' : 'interpretation_unavailable')
        : null,
      interpreted_at: new Date().toISOString(),
    })
    await updateApplication(svc, application.id, {
      status: out.report.status,
      percent_complete: out.report.percent,
    })
    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId,
      action: borrowerSide ? 'application_turn' : 'application_turn_assisted',
      target: turnId, req,
    })

    // ── 7 ──────────────────────────────────────────────────────────────────
    return json({
      ok: true,
      turnId,
      // Echoed so the screen can keep saying whose application this is. A team member who forgets
      // they are entering for someone else is how a file ends up misattributed.
      assisted: borrowerSide ? null : { partyIndex: assistPartyIndex, takenVia },
      accepted: out.accepted,
      message: out.message,
      confirmation: out.confirmation,
      nextQuestion: out.nextQuestion,
      // The borrower is told plainly when we could not interpret, and is NOT asked to retype.
      degraded,
      // Two very different situations must not share one message: the answer was captured by
      // deterministic parsing, or nothing was captured at all.
      degradedNotice: degraded
        ? (out.usedDeterministicFallback && out.accepted.length
            ? parsedNotice(locale) : degradedNotice(locale))
        : null,
      interpretedBy: interpretation ? 'model' : (out.usedDeterministicFallback ? 'deterministic' : 'none'),
      safetyFlags: out.safetyFlags,
      ...summaries(out.state, out.nextQuestion, locale, asOfMonth, out.report),
    })
  } catch (e) {
    logEvent('c1003.turn.error', { severity: 'error', requestId: correlationId, message: e?.message })
    return json({ ok: false, error: 'We saved your answer but hit a problem. Please try again.', requestId: correlationId }, 500)
  }
}

function summaries(state, nextQuestion, locale, asOfMonth, report) {
  const r = report || null
  if (!r) return {}
  return {
    review: buildReview(state, r, { locale }),
    progress: {
      percent: r.percent,
      status: r.status,
      openCount: r.openFields.length + r.structural.length,
      conflictCount: r.conflicts.length,
      meaning: r.meaning,
      notMeaning: r.notMeaning,
    },
    canAttest: r.everythingResolved,
  }
}

// The answer WAS captured — by parsing, not interpretation. Saying "I couldn't read it" here
// would be false and would make the borrower retype something already stored.
const parsedNotice = (locale) => ({
  en: 'Got it. (The assistant is running in basic mode right now, so answer one question at a time.)',
  es: 'Entendido. (El asistente está en modo básico ahora; responda una pregunta a la vez.)',
  ru: 'Записал. (Ассистент сейчас работает в базовом режиме — отвечайте по одному вопросу.)',
}[locale] || 'Got it. (The assistant is running in basic mode right now, so answer one question at a time.)')

const degradedNotice = (locale) => ({
  en: "I saved what you wrote, but I couldn't read it just now. Let's keep going — you don't need to type it again.",
  es: 'Guardé lo que escribió, pero no pude interpretarlo en este momento. Sigamos; no necesita escribirlo de nuevo.',
  ru: 'Я сохранил ваш ответ, но сейчас не смог его разобрать. Продолжим — повторять не нужно.',
}[locale] || "I saved what you wrote, but I couldn't read it just now. Let's keep going — you don't need to type it again.")
