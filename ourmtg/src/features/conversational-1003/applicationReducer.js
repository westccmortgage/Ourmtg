// Conversational 1003 — the application state machine.
//
// The reducer is the ONLY writer of application field state. It is append-only: every accepted
// change produces an immutable field event, and the "current" view is a projection of those
// events. Nothing here calls a model, a database, or the clock — callers pass `at` and `id`
// so the same inputs always produce the same events (which is what makes replay and the
// idempotency guarantees in §24 work).
//
// Load-bearing rules encoded here:
//   • A confirmed value is never silently overwritten (§7).
//   • A changed answer supersedes — it does not delete (§7).
//   • Secure fields never accept conversational text (§15).
//   • Demographic fields never accept model-interpreted input (§26).
//   • Contradictions are recorded as `conflicting`; the engine never picks a winner (§10/§28.14).

import { FIELD_SOURCE, isBorrowerSource, APPLICATION_SCHEMA_VERSION } from './types.js'
import { getField, isKnownField, templatePath } from './applicationCatalog.js'
import { normalizeByType, detectEstimateLanguage } from './normalization.js'

// Sources that mean "a human borrower supplied this through a controlled, non-conversational
// control" — the masked secure box, or a controlled selection list (demographics, declarations).
// Distinct from borrower_text/borrower_voice_transcript, which are model-interpreted.
const STRUCTURED_BORROWER_SOURCE = 'borrower_secure_input'

export function emptyState({ applicationId = null, partyCount = 1, locale = 'en' } = {}) {
  return {
    applicationId,
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    locale,
    partyCount,
    fields: {},      // path → current projected view
    history: {},     // path → [event, …] oldest-first, including superseded
    conflicts: {},   // path → { values: [...], since }
    events: [],
    counters: { events: 0 },
  }
}

const equalValues = (a, b) => {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005
  if (a == null || b == null) return false
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}

/**
 * Validate + normalize a proposed value for a field. Pure; returns a decision object rather
 * than throwing, so the caller can turn a rejection into a borrower-friendly question.
 */
export function validateCandidate({ path, rawValue, originalText = '', source = 'borrower_text' }) {
  if (!isKnownField(path)) {
    return { ok: false, code: 'unknown_field', message: 'Field is not in the catalog' }
  }
  if (!FIELD_SOURCE.includes(source)) {
    return { ok: false, code: 'unknown_source', message: 'Unknown source' }
  }
  const field = getField(path)

  // §15 — a secure field can only ever be written by the masked, server-validated control.
  if (field.secureEntry && source !== STRUCTURED_BORROWER_SOURCE && source !== 'team_entry') {
    return { ok: false, code: 'secure_entry_required', field, message: 'This must be entered in the secure box' }
  }
  // §26 — demographics and language preference must never be model-interpreted or inferred.
  if (field.aiInferenceForbidden && isBorrowerSource(source) && source !== STRUCTURED_BORROWER_SOURCE) {
    return { ok: false, code: 'controlled_selection_required', field, message: 'This must be chosen by the borrower directly' }
  }

  // A secure field arriving from the masked control stores its MASK, not a value the type
  // normalizer would ever accept (the ssn/account normalizers reject everything by design).
  // Enforce that what we were handed really is a mask, so a plaintext SSN can't slip through
  // by claiming the secure source.
  if (field.secureEntry) {
    const masked = String(rawValue ?? '').trim()
    if (!masked || /\d{5,}/.test(masked)) {
      return { ok: false, code: 'masked_value_required', field, message: 'Secure fields store only a mask' }
    }
    return { ok: true, field, value: masked.slice(0, 32), estimated: false }
  }

  const norm = normalizeByType(field.type, rawValue, field)
  if (!norm.ok) {
    return { ok: false, code: norm.reason || 'unparsable', field, message: 'Could not read that value', partial: norm.partial || null }
  }
  const estimated = Boolean(norm.estimated) || detectEstimateLanguage(originalText)
  return { ok: true, field, value: norm.value, estimated }
}

/**
 * Record a proposed value. Returns { state, event, outcome } where outcome is one of:
 *   'stored'        new candidate (or confirmed, when the source is authoritative)
 *   'unchanged'     same value already present — no event written (keeps replay idempotent)
 *   'superseded'    replaced a previous value; the old event is retained as superseded
 *   'conflicting'   irreconcilable with an existing value; BOTH retained, planner must ask
 *   'rejected'      failed validation; nothing stored
 */
export function recordValue(state, input) {
  const {
    path, rawValue, originalText = '', source = 'borrower_text', turnId = null,
    confidence = null, at, eventId, isCorrection = false, actor = null,
    status: forcedStatus = null, clarificationReason = null,
  } = input

  const check = validateCandidate({ path, rawValue, originalText, source })
  if (!check.ok) {
    return { state, event: null, outcome: 'rejected', reason: check.code, message: check.message, partial: check.partial }
  }
  const { field, value, estimated } = check
  const current = state.fields[path] || null

  // Authoritative sources land already-resolved; conversational ones land as candidates and
  // must be confirmed when the catalog says the field is high-impact.
  const naturalStatus =
    forcedStatus ||
    (source === 'team_entry' ? 'team_confirmed'
      : source === STRUCTURED_BORROWER_SOURCE ? (field.confirmRequired ? 'candidate' : 'borrower_confirmed')
        : 'candidate')

  // No-op when the same value is already recorded in a non-superseded state.
  if (current && !isTerminalRewrite(current.status) && equalValues(current.normalized_value, value)) {
    // A structured/team source may still UPGRADE a candidate to resolved.
    const upgrades = rank(naturalStatus) > rank(current.status)
    if (!upgrades) return { state, event: null, outcome: 'unchanged' }
  }

  // ── Conflict vs correction ────────────────────────────────────────────────
  // A differing value against something already RESOLVED is only an overwrite when the
  // borrower is explicitly correcting. Otherwise it is a contradiction and we keep both.
  let outcome = 'stored'
  let status = naturalStatus
  if (current && !equalValues(current.normalized_value, value) && current.status !== 'superseded') {
    const currentResolved = ['borrower_confirmed', 'team_confirmed'].includes(current.status)
    if (currentResolved && !isCorrection && source !== 'team_entry') {
      outcome = 'conflicting'
      status = 'conflicting'
    } else if (!currentResolved && field.confirmRequired && !isCorrection && current.status === 'candidate') {
      // Two different unconfirmed answers to a high-impact question — do not pick one (§28.14).
      outcome = 'conflicting'
      status = 'conflicting'
    } else {
      outcome = 'superseded'
    }
  }

  const event = Object.freeze({
    id: eventId,
    field_path: path,
    template_path: templatePath(path),
    normalized_value: value,
    display_value: displayValue(field, value, estimated),
    status,
    source,
    source_turn_id: turnId,
    original_text: isBorrowerSource(source) && !field.secureEntry ? truncate(originalText, 1000) : null,
    confidence: confidence == null ? null : Number(confidence),
    estimated,
    is_correction: Boolean(isCorrection),
    clarification_reason: clarificationReason,
    previous_event_id: current?.event_id ?? null,
    application_version: state.schemaVersion,
    catalog_version: field.version,
    actor,
    created_at: at,
  })

  return { state: applyEvent(state, event), event, outcome }
}

const rank = (s) => ({
  missing: 0, superseded: 0, conflicting: 1, needs_clarification: 1, candidate: 2,
  declined_allowed: 3, not_applicable: 3, borrower_confirmed: 4, team_confirmed: 5,
}[s] ?? 0)

const isTerminalRewrite = (s) => s === 'superseded'

function truncate(s, n) {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) : t
}

function displayValue(field, value, estimated) {
  if (value == null) return null
  let base
  switch (field.type) {
    case 'amount': base = `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; break
    case 'percent': base = `${value}%`; break
    case 'boolean': base = value ? 'Yes' : 'No'; break
    case 'phone': base = String(value).replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'); break
    case 'enum': case 'frequency': base = String(value).replace(/_/g, ' '); break
    default: base = String(value)
  }
  return estimated ? `~${base}` : base
}

/** Project one event onto the state. Append-only: the previous view becomes superseded. */
export function applyEvent(state, event) {
  const path = event.field_path
  const prior = state.fields[path] || null
  const history = state.history[path] ? [...state.history[path]] : []

  if (prior) {
    // The prior view is retained in history, flagged superseded unless we are keeping both
    // sides of a conflict for the borrower to resolve.
    const priorStatus = event.status === 'conflicting' ? prior.status : 'superseded'
    history[history.length - 1] = { ...history[history.length - 1], status: priorStatus }
  }
  const view = {
    event_id: event.id,
    field_path: path,
    normalized_value: event.normalized_value,
    display_value: event.display_value,
    status: event.status,
    source: event.source,
    source_turn_id: event.source_turn_id,
    original_text: event.original_text,
    confidence: event.confidence,
    estimated: event.estimated,
    clarification_reason: event.clarification_reason,
    previous_event_id: event.previous_event_id,
    application_version: event.application_version,
    created_at: event.created_at,
    updated_at: event.created_at,
    confirmed_at: ['borrower_confirmed', 'team_confirmed'].includes(event.status) ? event.created_at : null,
    confirmed_by: ['borrower_confirmed', 'team_confirmed'].includes(event.status) ? event.actor : null,
  }
  history.push(view)

  const conflicts = { ...state.conflicts }
  if (event.status === 'conflicting') {
    const previousValues = conflicts[path]?.values || (prior ? [prior.normalized_value] : [])
    conflicts[path] = {
      values: dedupe([...previousValues, event.normalized_value]),
      since: conflicts[path]?.since || event.created_at,
    }
  } else {
    delete conflicts[path]
  }

  return {
    ...state,
    fields: { ...state.fields, [path]: view },
    history: { ...state.history, [path]: history },
    conflicts,
    events: [...state.events, event],
    counters: { ...state.counters, events: state.counters.events + 1 },
  }
}

const dedupe = (arr) => [...new Set(arr.map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s))

/** Rebuild state from an ordered event log (used on resume and by the server projector). */
export function reduceEvents(events, init = {}) {
  return (events || []).reduce((s, e) => applyEvent(s, e), emptyState(init))
}

// ── Explicit transitions ─────────────────────────────────────────────────────

/** Borrower (or team) affirms the current candidate. */
export function confirmValue(state, { path, at, eventId, actor = null, byTeam = false }) {
  const current = state.fields[path]
  if (!current) return { state, event: null, outcome: 'rejected', reason: 'nothing_to_confirm' }
  if (current.status === 'conflicting') {
    return { state, event: null, outcome: 'rejected', reason: 'resolve_conflict_first' }
  }
  const event = Object.freeze({
    ...toEventShape(current, state),
    id: eventId,
    status: byTeam ? 'team_confirmed' : 'borrower_confirmed',
    previous_event_id: current.event_id,
    source: byTeam ? 'team_entry' : current.source,
    actor,
    created_at: at,
  })
  return { state: applyEvent(state, event), event, outcome: 'confirmed' }
}

/** Resolve a contradiction by choosing one of the recorded values (borrower or team only). */
export function resolveConflict(state, { path, chosenValue, at, eventId, actor = null, byTeam = false }) {
  const conflict = state.conflicts[path]
  if (!conflict) return { state, event: null, outcome: 'rejected', reason: 'no_conflict' }
  const field = getField(path)
  const norm = normalizeByType(field.type, chosenValue, field)
  if (!norm.ok) return { state, event: null, outcome: 'rejected', reason: 'unparsable' }
  if (!conflict.values.some((v) => equalValues(v, norm.value))) {
    return { state, event: null, outcome: 'rejected', reason: 'not_a_recorded_value' }
  }
  const event = Object.freeze({
    ...toEventShape(state.fields[path], state),
    id: eventId,
    normalized_value: norm.value,
    display_value: displayValue(field, norm.value, false),
    status: byTeam ? 'team_confirmed' : 'borrower_confirmed',
    estimated: false,
    is_correction: true,
    previous_event_id: state.fields[path]?.event_id ?? null,
    source: byTeam ? 'team_entry' : 'borrower_secure_input',
    actor,
    created_at: at,
  })
  return { state: applyEvent(state, event), event, outcome: 'resolved' }
}

/** Mark a field not-applicable. `ruleId` records WHICH validated rule permitted it (§13). */
export function markNotApplicable(state, { path, ruleId, at, eventId, actor = null }) {
  const field = getField(path)
  if (!field) return { state, event: null, outcome: 'rejected', reason: 'unknown_field' }
  const event = Object.freeze({
    id: eventId, field_path: path, template_path: templatePath(path),
    normalized_value: null, display_value: 'Not applicable', status: 'not_applicable',
    source: 'system_derived', source_turn_id: null, original_text: null, confidence: null,
    estimated: false, is_correction: false, clarification_reason: ruleId || null,
    previous_event_id: state.fields[path]?.event_id ?? null,
    application_version: state.schemaVersion, catalog_version: field.version,
    actor, created_at: at,
  })
  return { state: applyEvent(state, event), event, outcome: 'not_applicable' }
}

/** Record a permitted refusal. Rejected for fields where refusal is not allowed. */
export function declineField(state, { path, at, eventId, actor = null }) {
  const field = getField(path)
  if (!field) return { state, event: null, outcome: 'rejected', reason: 'unknown_field' }
  if (!field.allowDecline) return { state, event: null, outcome: 'rejected', reason: 'decline_not_permitted' }
  const event = Object.freeze({
    id: eventId, field_path: path, template_path: templatePath(path),
    normalized_value: null, display_value: 'Prefer not to provide', status: 'declined_allowed',
    source: 'borrower_secure_input', source_turn_id: null, original_text: null, confidence: null,
    estimated: false, is_correction: false, clarification_reason: null,
    previous_event_id: state.fields[path]?.event_id ?? null,
    application_version: state.schemaVersion, catalog_version: field.version,
    actor, created_at: at,
  })
  return { state: applyEvent(state, event), event, outcome: 'declined' }
}

/** Flag a stored candidate as needing a targeted clarifying question. */
export function flagClarification(state, { path, reason, at, eventId }) {
  const current = state.fields[path]
  if (!current) return { state, event: null, outcome: 'rejected', reason: 'nothing_to_clarify' }
  const event = Object.freeze({
    ...toEventShape(current, state),
    id: eventId, status: 'needs_clarification', clarification_reason: reason,
    previous_event_id: current.event_id, created_at: at,
  })
  return { state: applyEvent(state, event), event, outcome: 'flagged' }
}

function toEventShape(view, state) {
  return {
    field_path: view.field_path,
    template_path: templatePath(view.field_path),
    normalized_value: view.normalized_value,
    display_value: view.display_value,
    status: view.status,
    source: view.source,
    source_turn_id: view.source_turn_id,
    original_text: view.original_text,
    confidence: view.confidence,
    estimated: view.estimated,
    is_correction: false,
    clarification_reason: view.clarification_reason,
    application_version: state.schemaVersion,
    catalog_version: getField(view.field_path)?.version || null,
    actor: null,
  }
}

// ── Read helpers used by the planner, completeness engine, and UI ────────────
export const fieldView = (state, path) => state.fields[path] || null
export const fieldStatus = (state, path) => state.fields[path]?.status || 'missing'
export const fieldValue = (state, path) => state.fields[path]?.normalized_value ?? null
export const fieldHistory = (state, path) => state.history[path] || []
export const conflictList = (state) =>
  Object.entries(state.conflicts).map(([path, c]) => ({ path, ...c }))

/** All instantiated paths that exist for a repeating group, e.g. parties[0].employment[…] */
export function groupIndices(state, partyIndex, group) {
  const prefix = `parties[${partyIndex}].${group}[`
  const seen = new Set()
  for (const p of Object.keys(state.fields)) {
    if (!p.startsWith(prefix)) continue
    const m = p.slice(prefix.length).match(/^(\d+)\]/)
    if (m) seen.add(Number(m[1]))
  }
  return [...seen].sort((a, b) => a - b)
}
