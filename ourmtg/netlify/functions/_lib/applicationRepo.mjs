// Conversational 1003 — persistence.
//
// Loads the append-only event log into the pure engine's in-memory state, and writes back the
// events the engine produced. The engine never touches the database; this module never makes
// product decisions. That split is what lets the same interview logic run in tests, in the
// browser, and on the server without three copies of the rules.

import { randomUUID } from 'node:crypto'
import {
  reduceEvents, emptyState,
} from '../../../src/features/conversational-1003/applicationReducer.js'
import {
  APPLICATION_SCHEMA_VERSION, CATALOG_VERSION, RULES_VERSION,
} from '../../../src/features/conversational-1003/types.js'
import { getField } from '../../../src/features/conversational-1003/applicationCatalog.js'

export const newId = () => randomUUID()

/** Current UTC month as 'YYYY-MM' — the engine's "today" for history-coverage math. */
export function currentMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Find (or create) the active application for a loan file. Creation is idempotent under
 * concurrent first-turns: a unique (loan_file_id, application_version) means the loser of a
 * race re-reads instead of producing a second application.
 */
export async function ensureApplication(svc, { loanFile, createdBy, locale = 'en' }) {
  const { data: existing, error } = await svc
    .from('mortgage_applications')
    .select('*')
    .eq('loan_file_id', loanFile.id)
    .order('application_version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('application read: ' + error.message)
  if (existing) return existing

  const insert = {
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    application_version: 1,
    status: 'not_started',
    schema_version: APPLICATION_SCHEMA_VERSION,
    catalog_version: CATALOG_VERSION,
    rules_version: RULES_VERSION,
    locale,
    created_by: createdBy || null,
  }
  const { data, error: iErr } = await svc
    .from('mortgage_applications').insert(insert).select('*').maybeSingle()
  if (iErr) {
    // 23505 = someone else created version 1 first; take theirs.
    if (iErr.code === '23505') return ensureApplication(svc, { loanFile, createdBy, locale })
    throw new Error('application create: ' + iErr.message)
  }
  return data
}

/** Find (or create) the party row for this caller. Borrower = index 0, co-borrower = index 1. */
export async function ensureParty(svc, { application, loanFile, userId, visibility, locale }) {
  const { data: existing, error } = await svc
    .from('application_parties')
    .select('*')
    .eq('application_id', application.id)
    .eq('portal_user', userId)
    .maybeSingle()
  if (error) throw new Error('party read: ' + error.message)
  if (existing) return existing

  const role = visibility === 'coborrower' ? 'coborrower' : 'borrower'
  const partyIndex = role === 'coborrower' ? 1 : 0

  // The loan team may have opened this seat already, by taking the application over the phone
  // before the borrower ever signed in. That row is theirs — it has their answers on it — so
  // the borrower claims it rather than colliding with it and getting a stranger's party id.
  const seat = await unclaimedSeat(svc, application.id, partyIndex)
  if (seat) {
    const { data: claimed } = await svc
      .from('application_parties')
      .update({ portal_user: userId, ...(locale ? { locale } : {}) })
      .eq('id', seat.id)
      .is('portal_user', null)      // lost race ⇒ zero rows, and we fall through to re-read
      .select('*')
      .maybeSingle()
    if (claimed) return claimed
    const { data: reread } = await svc.from('application_parties').select('*').eq('id', seat.id).maybeSingle()
    if (reread) return reread
  }

  const insert = {
    application_id: application.id,
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    party_index: partyIndex,
    party_role: role,
    portal_user: userId,
    locale: locale || null,
  }
  const { data, error: iErr } = await svc
    .from('application_parties').insert(insert).select('*').maybeSingle()
  if (iErr) {
    if (iErr.code === '23505') {
      const { data: raced } = await svc.from('application_parties').select('*')
        .eq('application_id', application.id).eq('party_index', partyIndex).maybeSingle()
      if (raced) return raced
    }
    throw new Error('party create: ' + iErr.message)
  }
  return data
}

/**
 * The party row a team member is answering FOR, created without an account behind it.
 *
 * Deliberately never binds portal_user: the loan officer is not becoming the borrower. The seat
 * stays empty until the real person signs in through their invite and ensureParty claims it,
 * and everything recorded in the meantime is already attached to the right party.
 */
export async function ensurePartyByIndex(svc, { application, loanFile, partyIndex, locale }) {
  const index = partyIndex === 1 ? 1 : 0
  const { data: existing, error } = await svc
    .from('application_parties')
    .select('*')
    .eq('application_id', application.id)
    .eq('party_index', index)
    .maybeSingle()
  if (error) throw new Error('party read: ' + error.message)
  if (existing) return existing

  const insert = {
    application_id: application.id,
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    party_index: index,
    party_role: index === 1 ? 'coborrower' : 'borrower',
    portal_user: null,
    locale: locale || null,
  }
  const { data, error: iErr } = await svc
    .from('application_parties').insert(insert).select('*').maybeSingle()
  if (iErr) {
    if (iErr.code === '23505') {
      const { data: raced } = await svc.from('application_parties').select('*')
        .eq('application_id', application.id).eq('party_index', index).maybeSingle()
      if (raced) return raced
    }
    throw new Error('party create: ' + iErr.message)
  }
  return data
}

async function unclaimedSeat(svc, applicationId, partyIndex) {
  const { data } = await svc
    .from('application_parties')
    .select('*')
    .eq('application_id', applicationId)
    .eq('party_index', partyIndex)
    .is('portal_user', null)
    .maybeSingle()
  return data || null
}

/** All parties on the application (team view and party-count for the engine). */
export async function listParties(svc, applicationId) {
  const { data, error } = await svc
    .from('application_parties').select('*')
    .eq('application_id', applicationId).order('party_index')
  if (error) throw new Error('parties read: ' + error.message)
  return data || []
}

/**
 * Rebuild engine state from the event log. Reading the log (not the projection) means the
 * projection can never silently diverge into being the source of truth.
 */
export async function loadState(svc, { application, partyCount = 1 }) {
  const { data, error } = await svc
    .from('application_field_events')
    .select('*')
    .eq('application_id', application.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw new Error('field events read: ' + error.message)

  const events = (data || []).map((row) => ({
    id: row.id,
    field_path: row.field_path,
    template_path: row.template_path,
    normalized_value: row.normalized_value === null ? null : unwrapValue(row.normalized_value),
    display_value: row.display_value,
    status: row.status,
    source: row.source,
    source_turn_id: row.source_turn_id,
    original_text: row.original_text,
    confidence: row.confidence === null ? null : Number(row.confidence),
    estimated: row.estimated,
    is_correction: row.is_correction,
    clarification_reason: row.clarification_reason,
    previous_event_id: row.previous_event_id,
    application_version: row.application_version,
    catalog_version: row.catalog_version,
    actor: row.actor_user_id,
    created_at: row.created_at,
  }))

  const base = emptyState({
    applicationId: application.id,
    partyCount,
    locale: application.locale || 'en',
  })
  return events.length ? { ...reduceEvents(events, { applicationId: application.id, partyCount, locale: application.locale || 'en' }) } : base
}

// jsonb round-trips scalars as themselves; keep numbers numeric and booleans boolean.
function unwrapValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'v' in v) return v.v
  return v
}
const wrapValue = (v) => (v === undefined ? null : v)

/**
 * Persist engine events plus the projection. Written in one pass per event so a partial
 * failure leaves the LOG correct (the projection is rebuildable; the log is not).
 */
export async function persistEvents(svc, { application, party, loanFile, events, turnId, meta = {} }) {
  if (!events?.length) return { written: 0 }
  const rows = events.map((e) => ({
    id: e.id || newId(),
    application_id: application.id,
    party_id: partyIdFor(e.field_path, party),
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    field_path: e.field_path,
    template_path: e.template_path,
    section: getField(e.field_path)?.section || null,
    normalized_value: wrapValue(e.normalized_value),
    display_value: e.display_value,
    status: e.status,
    source: e.source,
    source_turn_id: turnId || e.source_turn_id || null,
    original_text: e.original_text,
    confidence: e.confidence,
    estimated: Boolean(e.estimated),
    is_correction: Boolean(e.is_correction),
    clarification_reason: e.clarification_reason,
    previous_event_id: e.previous_event_id || null,
    application_version: e.application_version || APPLICATION_SCHEMA_VERSION,
    catalog_version: e.catalog_version || CATALOG_VERSION,
    prompt_version: meta.promptVersion || null,
    provider_name: meta.provider || null,
    provider_model: meta.model || null,
    actor_user_id: e.actor || null,
  }))

  const { error } = await svc.from('application_field_events').insert(rows)
  if (error) throw new Error('field events write: ' + error.message)

  // Mark the prior event superseded for audit readability (the projection already moved on).
  for (const r of rows) {
    if (!r.previous_event_id) continue
    await svc.from('application_field_events')
      .update({ superseded_by: r.id })
      .eq('id', r.previous_event_id)
      .then(null, () => {}) // audit nicety only; never fail the turn on it
  }
  return { written: rows.length }
}

const partyIdFor = (fieldPath, party) => (String(fieldPath).startsWith('loan.') ? null : party?.id || null)

/** Upsert the current-value projection from engine state. */
export async function syncProjection(svc, { application, party, loanFile, state, paths }) {
  const targets = paths && paths.length ? [...new Set(paths)] : Object.keys(state.fields)
  if (!targets.length) return { synced: 0 }
  const rows = targets.map((path) => {
    const v = state.fields[path]
    if (!v) return null
    return {
      application_id: application.id,
      party_id: partyIdFor(path, party),
      organization_id: loanFile.organization_id || null,
      loan_file_id: loanFile.id,
      field_path: path,
      section: getField(path)?.section || null,
      normalized_value: wrapValue(v.normalized_value),
      display_value: v.display_value,
      status: v.status,
      source: v.source,
      estimated: Boolean(v.estimated),
      confidence: v.confidence,
      event_id: v.event_id || null,
      conflict_values: state.conflicts[path] ? state.conflicts[path].values : null,
      confirmed_at: v.confirmed_at,
      confirmed_by: v.confirmed_by,
      updated_at: new Date().toISOString(),
    }
  }).filter(Boolean)
  if (!rows.length) return { synced: 0 }
  const { error } = await svc
    .from('application_field_state')
    .upsert(rows, { onConflict: 'application_id,field_path' })
  if (error) throw new Error('projection write: ' + error.message)
  return { synced: rows.length }
}

// ── Turns ────────────────────────────────────────────────────────────────────

/**
 * Claim an idempotency key by inserting the turn BEFORE any interpretation happens (§24
 * step 1: persist, then acknowledge, then interpret). Returns { created, turn, conflict }.
 *   created  — this caller owns the turn and should process it
 *   !created — a previous request already recorded it; replay its stored outcome
 *   conflict — same key, different payload: refuse rather than silently diverge
 */
export async function claimTurn(svc, { application, party, loanFile, idempotencyKey, requestHash, fields }) {
  const row = {
    application_id: application.id,
    party_id: party?.id || null,
    organization_id: loanFile.organization_id || null,
    loan_file_id: loanFile.id,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    processing_state: 'received',
    ...fields,
  }
  const { data, error } = await svc
    .from('application_turns').insert(row).select('*').maybeSingle()
  if (!error) return { created: true, turn: data }
  if (error.code !== '23505') throw new Error('turn write: ' + error.message)

  const { data: existing, error: rErr } = await svc
    .from('application_turns').select('*')
    .eq('application_id', application.id).eq('idempotency_key', idempotencyKey).maybeSingle()
  if (rErr) throw new Error('turn reread: ' + rErr.message)
  if (existing && existing.request_hash !== requestHash) {
    return { created: false, turn: existing, conflict: true }
  }
  return { created: false, turn: existing }
}

export async function updateTurn(svc, turnId, patch) {
  const { error } = await svc.from('application_turns').update(patch).eq('id', turnId)
  if (error) throw new Error('turn update: ' + error.message)
}

export async function listTurns(svc, applicationId, { limit = 50 } = {}) {
  const { data, error } = await svc
    .from('application_turns').select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error('turns read: ' + error.message)
  return data || []
}

// ── Application-level bookkeeping ────────────────────────────────────────────

export async function updateApplication(svc, applicationId, patch) {
  const { error } = await svc
    .from('mortgage_applications')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', applicationId)
  if (error) throw new Error('application update: ' + error.message)
}

export async function saveAskedHistory(svc, partyId, askedHistory) {
  if (!partyId) return
  const { error } = await svc
    .from('application_parties')
    .update({ asked_history: askedHistory || {}, updated_at: new Date().toISOString() })
    .eq('id', partyId)
  if (error) throw new Error('asked history write: ' + error.message)
}
