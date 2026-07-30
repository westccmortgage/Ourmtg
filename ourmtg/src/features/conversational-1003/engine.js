// Conversational 1003 — the turn engine (pure orchestration).
//
// One function, `processTurn`, takes the current application state plus a VALIDATED
// interpretation and produces the next state, what to say, and what to ask next. It performs
// no I/O and reads no clock: the caller supplies `at` and an `ids` generator, which is what
// lets the server replay a turn idempotently and lets tests be exact.
//
// The provider is optional by design. With a mock provider, a live provider, or NO provider at
// all (timeout / outage), this function still returns a usable next question — §24's promise
// that a borrower's answer never disappears because a model was slow.

import { BORROWER_INTENTS } from './types.js'
import { getField, groupOf, recordPrefix } from './applicationCatalog.js'
import {
  recordValue, confirmValue, declineField, markNotApplicable, flagClarification,
  resolveConflict, fieldValue, groupIndices,
} from './applicationReducer.js'
import { computeCompleteness } from './completenessEngine.js'
import { planNextQuestion, noteAsked, noteSkipped } from './questionPlanner.js'
import { detectMisunderstanding, buildRecovery, summarizeSaved } from './misunderstanding.js'
import { buildConfirmation } from './confirmationPolicy.js'
import { monthlyEquivalent, detectUnknown, detectDecline } from './normalization.js'
import { redactSensitive } from './turnContract.js'
import { deterministicInterpretation } from './deterministicExtract.js'

/**
 * @param state    ApplicationState
 * @param input    {
 *   turnId, text, source='borrower_text', locale='en', askedQuestion (the Question object),
 *   interpretation (output of validateTurnResponse().value, or null when unavailable),
 *   intent (BORROWER_INTENTS, default 'answer'), askedHistory, at, asOfMonth,
 *   ids: () => string, activeGroup, attested, teamAccepted
 * }
 */
export function processTurn(state, input) {
  const {
    turnId = null, text = '', source = 'borrower_text', locale = 'en',
    askedQuestion = null, interpretation = null, intent = 'answer',
    askedHistory = {}, at, asOfMonth, ids, activeGroup = null,
    attested = false, teamAccepted = false,
  } = input

  const nextId = typeof ids === 'function' ? ids : (() => null)
  const askedPath = askedQuestion?.fieldPath || null
  let working = state
  let history = { ...askedHistory }
  const accepted = []
  const rejectedOut = []
  const safety = new Set(interpretation?.safetyFlags || [])

  // Borrower text is scrubbed of anything that must never persist, before anything else
  // touches it (§15). The scrubbed text is what the transcript stores.
  const { text: safeText, redacted } = redactSensitive(text)
  if (redacted) safety.add('sensitive_value_detected')

  // ── Non-answer intents ─────────────────────────────────────────────────────
  const resolvedIntent = resolveIntent(intent, safeText, askedQuestion)
  if (resolvedIntent !== 'answer') {
    const handled = handleIntent(working, {
      intent: resolvedIntent, askedQuestion, history, at, nextId, locale,
    })
    working = handled.state
    history = handled.history
    if (handled.terminal) {
      const report = computeCompleteness(working, { asOfMonth, attested, teamAccepted })
      const nextQuestion = handled.repeatQuestion
        ? askedQuestion
        : planNextQuestion(working, { asOfMonth, locale, askedHistory: history, activeGroup, attested, teamAccepted })
      return finish({
        state: working, history, accepted, rejected: rejectedOut, report, nextQuestion,
        message: handled.message, safety, intent: resolvedIntent, at, askedQuestion,
      })
    }
  }

  // ── Extractions ────────────────────────────────────────────────────────────
  // When no usable interpretation arrived — no provider configured, a timeout, a refusal, or a
  // response that failed the contract — fall back to deterministic parsing of the asked field.
  // A borrower who answers the question directly is still captured; only cross-field
  // understanding is lost, and that loss is reported to the caller rather than hidden.
  const effective = interpretation
    || (resolvedIntent === 'answer' ? deterministicInterpretation({ text: safeText, askedQuestion }) : null)
  const usedDeterministicFallback = !interpretation && Boolean(effective)
  const extractions = effective?.extractions || []
  for (const e of extractions) {
    const res = recordValue(working, {
      path: e.fieldPath,
      rawValue: e.normalizedCandidate,
      originalText: e.rawText || safeText,
      source,
      turnId,
      confidence: e.confidence,
      at,
      eventId: nextId(),
      isCorrection: resolvedIntent === 'correct_something',
    })
    if (res.outcome === 'rejected') {
      rejectedOut.push({ path: e.fieldPath, reason: res.reason })
      continue
    }
    working = res.state
    if (res.outcome !== 'unchanged') {
      const view = working.fields[e.fieldPath]
      accepted.push({
        path: e.fieldPath,
        value: view.normalized_value,
        displayValue: view.display_value,
        estimated: view.estimated,
        outcome: res.outcome,
      })
    }
    // The model flagged its own uncertainty — record it so the planner asks rather than assumes.
    if (e.requiresClarification) {
      const flagged = flagClarification(working, {
        path: e.fieldPath, reason: e.reason || 'model_flagged_ambiguous', at, eventId: nextId(),
      })
      if (flagged.event) working = flagged.state
    }
  }

  // Derived values (never labeled borrower-provided).
  working = recomputeDerived(working, { at, nextId })

  // Structural gates: an explicit "no" closes a whole section deterministically.
  working = applyGateClosures(working, { at, nextId })

  // ── Misunderstanding ───────────────────────────────────────────────────────
  const detection = detectMisunderstanding({
    askedPath,
    extractions: accepted.map((a) => ({ path: a.path, value: a.value, displayValue: a.displayValue })),
    originalText: safeText,
  })

  const report = computeCompleteness(working, { asOfMonth, attested, teamAccepted })

  // Confusion escalates the NEXT asking of the same question, not the borrower's patience.
  const confused = Boolean(detection.kind) || effective?.answerRelevance === 'unclear'
  if (askedQuestion) history = noteAsked(history, askedQuestion.id, { at, confused })

  const nextQuestion = planNextQuestion(working, {
    asOfMonth, locale, askedHistory: history,
    activeGroup: activeGroup || sectionOf(askedPath) || null,
    attested, teamAccepted,
  })

  let message = null
  if (detection.kind) {
    const savedSummary = summarizeSaved(
      accepted.map((a) => ({ path: a.path, value: a.value, displayValue: a.displayValue })), locale,
    )
    // The follow-up is the planner's question when we still need the same field, so the
    // recovery ends with exactly ONE precise ask (§10.5).
    const followUp = nextQuestion?.fieldPath === askedPath ? nextQuestion.prompt : (askedQuestion?.prompt || '')
    message = buildRecovery({ kind: detection.kind, locale, savedSummary, followUpQuestion: followUp })
  }

  const confirmation = buildConfirmation(accepted, { locale })

  return finish({
    state: working, history, accepted, rejected: rejectedOut, report, nextQuestion,
    message, confirmation, safety, detection, intent: resolvedIntent, at, askedQuestion,
    usedDeterministicFallback,
  })
}

function finish({ state, history, accepted, rejected, report, nextQuestion, message = null, confirmation = null, safety, detection = null, intent, at, askedQuestion, usedDeterministicFallback = false }) {
  return {
    state,
    askedHistory: history,
    accepted,
    rejected,
    report,
    nextQuestion,
    message,
    confirmation,
    detection,
    intent,
    safetyFlags: [...safety],
    // True when the answer was parsed rather than interpreted — the caller tells the borrower
    // plainly and the team view can distinguish the two.
    usedDeterministicFallback,
    at,
    askedQuestionId: askedQuestion?.id || null,
  }
}

// ── Intents ──────────────────────────────────────────────────────────────────

function resolveIntent(intent, text, askedQuestion) {
  if (BORROWER_INTENTS.includes(intent) && intent !== 'answer') return intent
  // Fall back to deterministic detection of the two intents that must never be misread as an
  // answer: "I don't know" and an explicit refusal (§10 unsure_vs_refusal).
  if (detectDecline(text) && askedQuestion?.allowDecline) return 'decline_to_provide'
  if (detectUnknown(text)) return 'do_not_know'
  return 'answer'
}

function handleIntent(state, { intent, askedQuestion, history, at, nextId, locale }) {
  const path = askedQuestion?.fieldPath || null
  switch (intent) {
    case 'why_asking':
      return {
        state, history, terminal: true, repeatQuestion: true,
        message: { text: askedQuestion?.why || '', parts: { explanation: askedQuestion?.why || '' }, kind: 'why_asking', locale },
      }
    case 'do_not_understand': {
      const h = askedQuestion ? noteAsked(history, askedQuestion.id, { at, confused: true }) : history
      return {
        state, history: h, terminal: true, repeatQuestion: false,
        message: { text: askedQuestion?.why || '', parts: { explanation: askedQuestion?.why || '' }, kind: 'do_not_understand', locale },
      }
    }
    case 'do_not_know': {
      // Not an answer and not a refusal: defer, keep it open, and move on.
      const h = askedQuestion ? noteSkipped(history, askedQuestion.id, { at }) : history
      return { state, history: h, terminal: true, message: { text: '', parts: {}, kind: 'deferred', locale } }
    }
    case 'skip_for_now': {
      const h = askedQuestion ? noteSkipped(history, askedQuestion.id, { at }) : history
      return { state, history: h, terminal: true, message: { text: '', parts: {}, kind: 'skipped', locale } }
    }
    case 'decline_to_provide': {
      if (!path) return { state, history, terminal: true, message: null }
      const res = declineField(state, { path, at, eventId: nextId() })
      // Refusal is only recorded where it is permitted; elsewhere it stays open with no pressure.
      const h = res.event ? history : noteSkipped(history, askedQuestion.id, { at })
      return { state: res.state, history: h, terminal: true, message: { text: '', parts: {}, kind: 'declined', locale } }
    }
    case 'show_saved':
    case 'talk_to_team':
      return { state, history, terminal: true, repeatQuestion: true, message: { text: '', parts: {}, kind: intent, locale } }
    case 'correct_something':
      return { state, history, terminal: false, message: null } // fall through to extraction
    default:
      return { state, history, terminal: false, message: null }
  }
}

// ── Derived + structural maintenance ─────────────────────────────────────────

/**
 * Recompute system-derived values. These are written with source 'system_derived' so they can
 * never be mistaken for something the borrower said (§7).
 */
function recomputeDerived(state, { at, nextId }) {
  let working = state
  const partyCount = Math.max(1, state.partyCount || 1)
  for (let p = 0; p < partyCount; p++) {
    for (const i of groupIndices(working, p, 'income')) {
      const base = `parties[${p}].income[${i}]`
      const amount = fieldValue(working, `${base}.amount`)
      const freq = fieldValue(working, `${base}.frequency`)
      const hours = fieldValue(working, `${base}.hoursPerWeek`)
      if (amount == null || freq == null) continue
      const m = monthlyEquivalent(amount, freq, { hoursPerWeek: hours })
      if (!m.ok) continue
      const res = recordValue(working, {
        path: `${base}.monthlyEquivalent`, rawValue: m.value, source: 'system_derived',
        at, eventId: nextId(), status: 'team_confirmed',
      })
      if (res.event) working = res.state
    }
  }
  return working
}

/**
 * When a gating question is answered "no", close its whole section as not_applicable under a
 * named rule — so completeness can distinguish "no debts" from "we never asked" (§13).
 */
function applyGateClosures(state, { at, nextId }) {
  let working = state
  const partyCount = Math.max(1, state.partyCount || 1)
  const gates = [
    { gate: 'hasAnyLiabilities', group: 'liabilities' },
    { gate: 'ownsOtherRealEstate', group: 'reo' },
  ]
  for (let p = 0; p < partyCount; p++) {
    for (const { gate, group } of gates) {
      if (fieldValue(working, `parties[${p}].${gate}`) !== false) continue
      // Nothing to mark unless records were already started; the completeness engine already
      // treats a false gate as "group not applicable".
      for (const i of groupIndices(working, p, group)) {
        const prefix = `parties[${p}].${group}[${i}]`
        for (const path of Object.keys(working.fields)) {
          if (!path.startsWith(prefix + '.')) continue
          if (working.fields[path].status === 'not_applicable') continue
          const res = markNotApplicable(working, { path, ruleId: `${gate}=false`, at, eventId: nextId() })
          if (res.event) working = res.state
        }
      }
    }
  }
  return working
}

const sectionOf = (path) => (path ? getField(path)?.section || null : null)

// ── Turn-level helpers the server uses ───────────────────────────────────────

/**
 * The minimum context a provider needs: the asked question, the allowed field paths for THIS
 * turn, and a compact summary of what is already known. Deliberately NOT the full transcript
 * (§21 "minimum necessary borrower context").
 */
export function buildProviderContext(state, { askedQuestion, locale = 'en', asOfMonth }) {
  const askedPath = askedQuestion?.fieldPath || null
  const allowed = allowedPathsForTurn(state, askedQuestion)
  return {
    locale,
    asOfMonth,
    askedQuestion: askedQuestion
      ? {
        fieldPath: askedPath,
        prompt: askedQuestion.prompt,
        dataType: askedQuestion.dataType,
        values: askedQuestion.values || null,
        escalation: askedQuestion.escalation,
      }
      : null,
    allowedFieldPaths: allowed,
    // Compact "already known" so the model does not re-ask; values only, no history, no PII
    // beyond what the borrower already gave for these very fields.
    known: allowed
      .map((p) => ({ fieldPath: p, value: fieldValue(state, p), status: state.fields[p]?.status || 'missing' }))
      .filter((k) => k.value != null),
  }
}

/**
 * The catalog paths the model may write on this turn: the asked field, its sibling record, and
 * the next slot of every open group (so a borrower who volunteers out-of-order facts is
 * captured — §9 — without opening the entire 100-field catalog every turn).
 */
export function allowedPathsForTurn(state, askedQuestion) {
  const paths = new Set()
  const partyCount = Math.max(1, state.partyCount || 1)
  const askedPath = askedQuestion?.fieldPath || null

  if (askedPath) {
    paths.add(askedPath)
    const group = groupOf(askedPath)
    if (group) {
      const prefix = recordPrefix(askedPath)
      for (const d of siblingsOf(askedPath)) paths.add(`${prefix}.${d}`)
    }
  }
  for (let p = 0; p < partyCount; p++) {
    for (const group of ['employment', 'income', 'residence', 'assets', 'liabilities', 'reo']) {
      const idx = groupIndices(state, p, group)
      const current = idx.length ? idx[idx.length - 1] : 0
      for (const slot of new Set([current, idx.length])) {
        for (const d of groupFieldNames(group)) paths.add(`parties[${p}].${group}[${slot}].${d}`)
      }
    }
    for (const d of ['legalFirstName', 'legalLastName', 'email', 'phone', 'dependentsCount',
      'hasAnyLiabilities', 'ownsOtherRealEstate', 'mailingAddressSameAsCurrent']) {
      paths.add(`parties[${p}].${d}`)
    }
  }
  for (const d of ['purpose', 'occupancy', 'purchasePrice', 'estimatedPropertyValue',
    'requestedLoanAmount', 'downPaymentAmount', 'propertyType', 'isUnderContract',
    'propertyStreet', 'propertyCity', 'propertyState', 'propertyPostalCode']) {
    paths.add(`loan.${d}`)
  }
  // Never expose secure or inference-forbidden paths to the model at all.
  return [...paths].filter((p) => {
    const f = getField(p)
    return f && !f.secureEntry && !f.aiInferenceForbidden
  })
}

import { CATALOG } from './applicationCatalog.js'
const GROUP_FIELD_NAMES = {}
for (const d of CATALOG) {
  const g = groupOf(d.path)
  if (!g) continue
  ;(GROUP_FIELD_NAMES[g] ||= []).push(d.path.split('.').pop())
}
const groupFieldNames = (g) => GROUP_FIELD_NAMES[g] || []
const siblingsOf = (path) => groupFieldNames(groupOf(path))

export { confirmValue, resolveConflict }
