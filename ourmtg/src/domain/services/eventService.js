// Phase 1B — pure append-only event service (FLAG-GATED: flags.eventServiceEnabled, default OFF).
//
// Immutable, idempotent domain-event ledger. No I/O: an injected persistence adapter makes it
// unit-testable and keeps production untouched. It NEVER mutates a prior event; a duplicate
// idempotency key returns the existing event without a second side effect. Not wired to any
// production endpoint. Metadata is stored as-is by the adapter — callers must not put secrets
// or unnecessary PII in it (see redaction policy); this module never logs metadata.

import { EVENT_TYPES } from '../lifecycles.js'

const VALID_ACTOR = new Set(['borrower', 'coborrower', 'realtor', 'escrow', 'title', 'loan_officer', 'processor', 'assistant', 'system', 'ai'])

// Adapter contract:
//   findByIdempotencyKey(organizationId, key) -> event | null
//   append(event) -> persisted event   (must enforce immutability at the storage layer too)
export function createEventService({ store }) {
  if (!store || typeof store.append !== 'function') throw new Error('eventService requires a store with append()')

  async function appendEvent(input = {}) {
    const {
      organization_id, loan_file_id, event_type, actor_type, actor_id,
      source_system, source_record_id, correlation_id, idempotency_key,
      previous_state, new_state, metadata,
    } = input

    if (!organization_id) return { ok: false, error: 'missing_organization_id' }
    if (!loan_file_id) return { ok: false, error: 'missing_loan_file_id' }
    if (!EVENT_TYPES.includes(event_type)) return { ok: false, error: 'invalid_event_type' }
    if (!actor_type || !VALID_ACTOR.has(actor_type)) return { ok: false, error: 'invalid_actor' }
    if (!source_system) return { ok: false, error: 'missing_source_system' }

    // Idempotency: a repeat key returns the existing event, no new side effect.
    if (idempotency_key && typeof store.findByIdempotencyKey === 'function') {
      const existing = await store.findByIdempotencyKey(organization_id, idempotency_key)
      if (existing) return { ok: true, event: existing, deduped: true }
    }

    const event = Object.freeze({
      organization_id,
      loan_file_id,
      event_type,
      actor_type,
      actor_id: actor_id ?? null,
      source_system,
      source_record_id: source_record_id ?? null,
      correlation_id: correlation_id ?? null,
      idempotency_key: idempotency_key ?? null,
      previous_state: previous_state ?? null,
      new_state: new_state ?? null,
      metadata: metadata ?? {},
      occurred_at: input.occurred_at ?? null, // caller supplies time; pure module reads no clock
    })
    const persisted = await store.append(event)
    return { ok: true, event: persisted || event, deduped: false }
  }

  return { appendEvent }
}
