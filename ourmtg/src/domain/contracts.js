// Phase 0 scaffolding — pure domain contracts (documentation-as-code).
//
// These are JSDoc @typedef definitions for the NEW domain objects proposed in
// docs/OURMTG-TARGET-DATA-MODEL.md (Part B). They carry ZERO runtime and no side effects — the
// only export is a frozen manifest used by the contract test to assert shape/vocab consistency.
// Nothing in production imports these. They exist for editor intellisense and to pin the
// intended shape before any migration is written.
//
// Every object below is service-role-written / RLS-read and carries owner_user_id (tenant) plus,
// where file-scoped, loan_file_id — matching the existing 036–039 conventions. No org_id exists.

import { EVENT_TYPES, TASK_STATUS, TASK_AUDIENCE, VENDOR_TYPE, VENDOR_STATUS, DELIVERY_CHANNEL, DELIVERY_STATUS, CTC_DIRECTION } from './vocab.js'

/**
 * @typedef {Object} LoanEvent  Immutable domain-event (draft B1). Append-only; idempotent.
 * @property {string} id
 * @property {string} owner_user_id            Tenant (broker auth.users.id).
 * @property {string|null} loan_file_id        Null for pre-file events (e.g. lead.created).
 * @property {string} event_type               One of vocab.EVENT_TYPES.
 * @property {string} actor_role               borrower|coborrower|realtor|lo|processor|system.
 * @property {string|null} actor_user_id
 * @property {Object} payload                  Event detail (e.g. { from, to } for stage_changed).
 * @property {string} idempotency_key          unique(owner_user_id, idempotency_key).
 * @property {string} created_at
 */

/**
 * @typedef {Object} LoanTask  Stored, assignable task (draft B2). Distinct from loan_conditions.
 * @property {string} id
 * @property {string} owner_user_id
 * @property {string} loan_file_id
 * @property {string|null} assignee_user_id    portal_team member or the owner.
 * @property {'team'|'borrower'} audience
 * @property {string} title
 * @property {string|null} detail
 * @property {'open'|'done'|'cancelled'} status
 * @property {string|null} due_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} NotificationDelivery  Delivery record (draft B3). Closes R5 (no tracking).
 * @property {string} id
 * @property {string} owner_user_id
 * @property {string|null} loan_file_id
 * @property {'email'|'sms'} channel
 * @property {string} template_key
 * @property {string} recipient
 * @property {'queued'|'sent'|'failed'|'skipped'} status
 * @property {string|null} provider_id
 * @property {string|null} error
 * @property {string} idempotency_key          unique(owner_user_id, idempotency_key).
 * @property {string} created_at
 */

/**
 * @typedef {Object} LoanVendorOrder  Appraisal/title/escrow/insurance status (draft B4).
 * @property {string} id
 * @property {string} owner_user_id
 * @property {string} loan_file_id
 * @property {'appraisal'|'title'|'escrow'|'insurance'} vendor_type
 * @property {string|null} vendor_name
 * @property {'ordered'|'in_progress'|'received'|'cleared'|'cancelled'} status
 * @property {string|null} ordered_at
 * @property {string|null} received_at
 * @property {Object} detail
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} LoanCashToClose  Actual CTC ledger line (draft B5). Borrower/coborrower only.
 * @property {string} id
 * @property {string} owner_user_id
 * @property {string} loan_file_id
 * @property {string} line_key
 * @property {string} label
 * @property {number} amount
 * @property {'credit'|'charge'} direction
 * @property {string} source                   LE|CD|manual.
 * @property {string|null} as_of
 * @property {string} created_at
 * @property {string} updated_at
 */

// Frozen manifest: maps each contract to the vocab arrays its constrained fields draw from.
// The contract test uses this to prove the typedefs and vocab agree, and that nothing here
// re-declares an existing app enum (stages/doc/condition/strategy statuses are absent on purpose).
export const CONTRACTS = Object.freeze({
  LoanEvent: { table: 'loan_events', tenant: 'owner_user_id', vocab: { event_type: EVENT_TYPES } },
  LoanTask: { table: 'loan_tasks', tenant: 'owner_user_id', vocab: { status: TASK_STATUS, audience: TASK_AUDIENCE } },
  NotificationDelivery: { table: 'notification_deliveries', tenant: 'owner_user_id', vocab: { channel: DELIVERY_CHANNEL, status: DELIVERY_STATUS } },
  LoanVendorOrder: { table: 'loan_vendor_orders', tenant: 'owner_user_id', vocab: { vendor_type: VENDOR_TYPE, status: VENDOR_STATUS } },
  LoanCashToClose: { table: 'loan_cash_to_close', tenant: 'owner_user_id', vocab: { direction: CTC_DIRECTION } },
})
