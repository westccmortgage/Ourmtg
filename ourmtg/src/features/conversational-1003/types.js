// Conversational 1003 — controlled vocabularies and schema versions.
//
// Every value a field, turn, or application can hold comes from a frozen list here. Nothing
// in this file depends on React, the DOM, or Node — the module is imported unchanged by the
// browser bundle (Vite), the Netlify functions, and the test runner. Keep it that way: the
// engine is meant to be liftable into RMTG or an embedded borrower workspace.

// Bump APPLICATION_SCHEMA_VERSION whenever the catalog's field paths/semantics change in a
// way that makes older stored rows non-comparable. Stored field events keep the version they
// were written under, so an application never silently changes meaning under the borrower.
export const APPLICATION_SCHEMA_VERSION = '2026.07.1003.1'
export const CATALOG_VERSION = '2026.07.1003.1'
export const RULES_VERSION = '2026.07.1003.1'

// ── Field lifecycle ──────────────────────────────────────────────────────────
// missing            never answered
// candidate          extracted from borrower language, not yet confirmed
// needs_clarification ambiguous/incomplete — the planner must ask a targeted question
// borrower_confirmed borrower explicitly affirmed the normalized value
// team_confirmed     loan team verified/corrected it (counts as resolved)
// not_applicable     a validated conditional rule removed the requirement
// declined_allowed   borrower used a legally/operationally permitted refusal
// conflicting        two irreconcilable statements — blocks completeness until resolved
// superseded         historical value replaced by a newer one (never counted, never deleted)
export const FIELD_STATUS = Object.freeze([
  'missing', 'candidate', 'needs_clarification', 'borrower_confirmed', 'team_confirmed',
  'not_applicable', 'declined_allowed', 'conflicting', 'superseded',
])

// A field counts toward completeness ONLY in these states.
export const RESOLVED_STATUSES = Object.freeze([
  'borrower_confirmed', 'team_confirmed', 'not_applicable', 'declined_allowed',
])

// Provenance. A derived value is NEVER labeled borrower-provided.
export const FIELD_SOURCE = Object.freeze([
  'borrower_text', 'borrower_voice_transcript', 'borrower_secure_input', 'team_entry',
  'imported_credit', 'imported_los', 'document_extraction', 'system_derived',
])
export const BORROWER_SOURCES = Object.freeze([
  'borrower_text', 'borrower_voice_transcript', 'borrower_secure_input',
])

// ── Application lifecycle ────────────────────────────────────────────────────
export const APPLICATION_STATUS = Object.freeze([
  'not_started', 'in_progress', 'waiting_on_borrower', 'needs_clarification',
  'ready_for_borrower_review', 'borrower_attested', 'ready_for_team_review',
  'returned_for_clarification', 'accepted_into_loan_file',
])

// ── Turn processing (idempotency + failure recovery, §24) ────────────────────
export const TURN_STATE = Object.freeze([
  'received', 'processing', 'interpreted', 'needs_retry', 'failed_safe',
])

// ── Data types the catalog may declare ───────────────────────────────────────
export const FIELD_TYPES = Object.freeze([
  'text', 'longtext', 'name', 'email', 'phone', 'address', 'date', 'month', 'year',
  'amount', 'percent', 'integer', 'boolean', 'enum', 'frequency', 'ssn', 'account_number',
])

// Income/payment frequencies. `monthlyEquivalent` in normalization.js is the only place
// that converts between them — the model never does arithmetic that reaches storage.
export const FREQUENCIES = Object.freeze([
  'hourly', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'one_time',
])

// How the borrower answered a question, per the AI turn contract (§8).
export const ANSWER_RELEVANCE = Object.freeze(['direct', 'partial', 'unrelated', 'unclear'])

// Misunderstanding categories the engine explicitly recognizes (§10).
export const MISUNDERSTANDING_KINDS = Object.freeze([
  'duration_vs_amount', 'monthly_vs_annual', 'employer_vs_occupation',
  'current_vs_mailing_address', 'owned_vs_purchasing_property', 'asset_balance_vs_income',
  'loan_amount_vs_purchase_price', 'gross_vs_net_income', 'start_date_vs_years_employed',
  'current_vs_previous_employer', 'borrower_vs_coborrower', 'value_vs_mortgage_balance',
  'rent_vs_property_tax', 'no_vs_not_applicable', 'unsure_vs_refusal',
])

// Non-answer intents a borrower may express at any question (§11).
export const BORROWER_INTENTS = Object.freeze([
  'answer', 'why_asking', 'do_not_understand', 'do_not_know', 'skip_for_now',
  'show_saved', 'correct_something', 'talk_to_team', 'decline_to_provide',
])

// Safety flags an interpretation may raise. `sensitive_value_detected` forces the engine to
// drop the raw text before persistence; `prompt_injection` is recorded and ignored.
export const SAFETY_FLAGS = Object.freeze([
  'sensitive_value_detected', 'prompt_injection', 'credential_request_detected',
  'demographic_inference_attempt', 'out_of_scope_request', 'distress_or_complaint',
])

export const PARTY_ROLES = Object.freeze(['borrower', 'coborrower'])

// Interface locales already shipped by OurMTG. Simplified Chinese is intentionally listed
// as a planned locale so the catalog/label shape is validated for it ahead of translation.
export const SUPPORTED_LOCALES = Object.freeze(['en', 'es', 'ru'])
export const PLANNED_LOCALES = Object.freeze(['zh-Hans'])

export const isResolved = (status) => RESOLVED_STATUSES.includes(status)
export const isBorrowerSource = (source) => BORROWER_SOURCES.includes(source)
