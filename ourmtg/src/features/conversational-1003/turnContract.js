// Conversational 1003 — the AI turn contract (§8).
//
// THIS IS A TRUST BOUNDARY. Everything the model returns is untrusted input. Nothing here
// assumes the model is well-behaved, honest, or even returning the right shape. A response
// that fails validation is discarded — the borrower's own words are already durably stored by
// then (§24), so a bad interpretation costs a retry, never an answer.
//
// What we reject, deliberately:
//   • field paths outside the catalog (invented paths)
//   • enum values outside the field's domain
//   • values that fail deterministic normalization (impossible dates, malformed amounts)
//   • negative amounts where they are impossible
//   • extractions targeting secure or AI-inference-forbidden fields
//   • strings that look like instructions to the system (prompt injection carried in "data")
//   • oversized payloads

import { ANSWER_RELEVANCE, MISUNDERSTANDING_KINDS, SAFETY_FLAGS } from './types.js'
import { getField, isKnownField } from './applicationCatalog.js'
import { normalizeByType } from './normalization.js'

export const MAX_EXTRACTIONS = 25
export const MAX_TEXT = 2000
export const MAX_RETRIES = 2

// Text that is trying to talk to the SYSTEM rather than describe borrower data. We do not try
// to be clever: anything matching is stripped from free-text fields and flagged, never obeyed.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|your\s+|previous\s+|the\s+)*(rules|instructions|prompt)/i,
  /disregard\s+(all\s+|your\s+|previous\s+|the\s+)/i,
  /\byou\s+are\s+now\b/i,
  /\bsystem\s*(prompt|message)\b/i,
  /\bmark\s+(everything|the\s+application|this)\s+(as\s+)?(complete|approved)/i,
  /\b(approve|pre-?approve)\s+(this\s+)?(loan|application)\b/i,
  /<\/?\s*(script|iframe|system|assistant)\b/i,
  /\{\{.*\}\}/,
  /\bexecute\b.*\b(sql|query|command)\b/i,
  /\bdrop\s+table\b/i,
]

export function looksLikeInjection(text) {
  const s = String(text || '')
  return INJECTION_PATTERNS.some((re) => re.test(s))
}

// Values that must never be carried in conversational text, even if the borrower typed them.
// We redact rather than store, and flag the turn so the UI can route to the secure control.
const SSN_RE = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g
const LONG_ACCOUNT_RE = /\b\d{9,17}\b/g

export function redactSensitive(text) {
  const s = String(text || '')
  let found = false
  const out = s
    .replace(SSN_RE, () => { found = true; return '[removed for your security]' })
    .replace(LONG_ACCOUNT_RE, () => { found = true; return '[removed for your security]' })
  return { text: out, redacted: found }
}

const str = (v, max = MAX_TEXT) => (v == null ? null : String(v).slice(0, max))
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

/**
 * Validate a raw model response against the turn contract.
 *
 * @returns {{ ok:boolean, value?:object, errors:string[], rejected:Array }}
 *          `value.extractions` contains ONLY entries that survived validation and carry the
 *          deterministically normalized value — the reducer re-validates anyway.
 */
export function validateTurnResponse(raw, { askedPath = null } = {}) {
  const errors = []
  const rejected = []

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['response_not_an_object'], rejected }
  }

  // ── scalar fields ─────────────────────────────────────────────────────────
  const answerRelevance = ANSWER_RELEVANCE.includes(raw.answerRelevance) ? raw.answerRelevance : null
  if (!answerRelevance) errors.push('answerRelevance_invalid')

  const misunderstandingDetected = raw.misunderstandingDetected === true
  const misunderstandingKind = MISUNDERSTANDING_KINDS.includes(raw.misunderstandingKind)
    ? raw.misunderstandingKind : null

  // The model's prose is displayed to a borrower — scrub it before it can ever be rendered.
  let explanation = str(raw.plainLanguageExplanation, 1200)
  if (explanation && looksLikeInjection(explanation)) {
    rejected.push({ reason: 'injection_in_explanation' })
    explanation = null
  }
  if (explanation) explanation = redactSensitive(explanation).text

  // ── extractions ───────────────────────────────────────────────────────────
  const rawExtractions = Array.isArray(raw.extractions) ? raw.extractions.slice(0, MAX_EXTRACTIONS) : []
  if (Array.isArray(raw.extractions) && raw.extractions.length > MAX_EXTRACTIONS) {
    errors.push('too_many_extractions')
  }
  const extractions = []
  for (const e of rawExtractions) {
    const v = validateExtraction(e)
    if (v.ok) extractions.push(v.value)
    else rejected.push({ fieldPath: e?.fieldPath ?? null, reason: v.reason })
  }

  // ── ancillary arrays ──────────────────────────────────────────────────────
  const unmappedFacts = (Array.isArray(raw.unmappedFacts) ? raw.unmappedFacts : [])
    .slice(0, 20)
    .map((u) => str(isPlainObject(u) ? u.text : u, 400))
    .filter(Boolean)
    .filter((t) => !looksLikeInjection(t))
    .map((t) => redactSensitive(t).text)

  const contradictions = (Array.isArray(raw.contradictions) ? raw.contradictions : [])
    .slice(0, 10)
    .map((c) => (isPlainObject(c) && isKnownField(c.fieldPath)
      ? { fieldPath: c.fieldPath, note: str(c.note, 300) } : null))
    .filter(Boolean)

  const clarificationTargets = (Array.isArray(raw.clarificationTargets) ? raw.clarificationTargets : [])
    .slice(0, 10)
    .map((c) => {
      const path = isPlainObject(c) ? c.fieldPath : c
      return isKnownField(path) ? { fieldPath: path, reason: str(isPlainObject(c) ? c.reason : null, 300) } : null
    })
    .filter(Boolean)

  const safetyFlags = (Array.isArray(raw.safetyFlags) ? raw.safetyFlags : [])
    .filter((s) => SAFETY_FLAGS.includes(s))

  // A response with an unusable shape fails; a response whose individual extractions were all
  // rejected is still usable (it just captured nothing).
  const ok = errors.length === 0

  return {
    ok,
    errors,
    rejected,
    value: {
      answerRelevance,
      misunderstandingDetected,
      misunderstandingKind,
      plainLanguageExplanation: explanation,
      extractions,
      unmappedFacts,
      contradictions,
      clarificationTargets,
      safetyFlags,
      askedPath,
    },
  }
}

function validateExtraction(e) {
  if (!isPlainObject(e)) return { ok: false, reason: 'not_an_object' }
  const path = e.fieldPath
  if (typeof path !== 'string' || !path) return { ok: false, reason: 'missing_field_path' }
  // §2 — the model may not create field paths. Unknown path ⇒ discarded, not stored anywhere.
  if (!isKnownField(path)) return { ok: false, reason: 'unknown_field_path' }

  const field = getField(path)
  // §15/§26 — the model may never supply these, regardless of what the borrower said.
  if (field.secureEntry) return { ok: false, reason: 'secure_entry_required' }
  if (field.aiInferenceForbidden) return { ok: false, reason: 'inference_forbidden' }

  const rawText = str(e.rawText, MAX_TEXT) || ''
  if (looksLikeInjection(rawText)) return { ok: false, reason: 'injection_in_raw_text' }

  const candidate = e.normalizedCandidate ?? e.value ?? null
  if (candidate == null || candidate === '') return { ok: false, reason: 'empty_candidate' }
  if (typeof candidate === 'object') return { ok: false, reason: 'candidate_not_scalar' }
  if (looksLikeInjection(String(candidate))) return { ok: false, reason: 'injection_in_candidate' }

  // Deterministic normalization is the arbiter — the model's own "normalizedCandidate" is
  // only a proposal and is re-parsed here.
  const norm = normalizeByType(field.type, candidate, field)
  if (!norm.ok) return { ok: false, reason: norm.reason || 'failed_normalization' }
  if (typeof norm.value === 'number' && norm.value < 0) return { ok: false, reason: 'negative_not_allowed' }

  let confidence = Number(e.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = null

  return {
    ok: true,
    value: {
      fieldPath: path,
      rawText: redactSensitive(rawText).text,
      normalizedCandidate: norm.value,
      estimated: Boolean(norm.estimated),
      confidence,
      requiresClarification: e.requiresClarification === true,
      requiresConfirmation: e.requiresConfirmation === true,
      reason: str(e.reason, 300),
    },
  }
}

/**
 * The JSON Schema handed to providers that support structured output. Kept in sync with the
 * validator above by turnContract's own contract test.
 */
export const TURN_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['answerRelevance', 'extractions'],
  properties: {
    answerRelevance: { type: 'string', enum: [...ANSWER_RELEVANCE] },
    misunderstandingDetected: { type: 'boolean' },
    misunderstandingKind: { type: ['string', 'null'], enum: [...MISUNDERSTANDING_KINDS, null] },
    plainLanguageExplanation: { type: ['string', 'null'], maxLength: 1200 },
    extractions: {
      type: 'array',
      maxItems: MAX_EXTRACTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fieldPath', 'normalizedCandidate'],
        properties: {
          fieldPath: { type: 'string' },
          rawText: { type: ['string', 'null'], maxLength: MAX_TEXT },
          normalizedCandidate: { type: ['string', 'number', 'boolean'] },
          confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          requiresClarification: { type: 'boolean' },
          requiresConfirmation: { type: 'boolean' },
          reason: { type: ['string', 'null'], maxLength: 300 },
        },
      },
    },
    unmappedFacts: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 400 } },
    contradictions: {
      type: 'array', maxItems: 10,
      items: { type: 'object', additionalProperties: false, properties: { fieldPath: { type: 'string' }, note: { type: ['string', 'null'] } }, required: ['fieldPath'] },
    },
    clarificationTargets: {
      type: 'array', maxItems: 10,
      items: { type: 'object', additionalProperties: false, properties: { fieldPath: { type: 'string' }, reason: { type: ['string', 'null'] } }, required: ['fieldPath'] },
    },
    safetyFlags: { type: 'array', items: { type: 'string', enum: [...SAFETY_FLAGS] } },
  },
})

// Structured-output schemas reject the constraint keywords above (maxLength, maxItems,
// minimum, maximum) and require additionalProperties:false on every object. Rather than keep
// two hand-maintained schemas that can drift, project the canonical one. The dropped
// constraints are still enforced — validateTurnResponse re-checks every one of them locally.
const UNSUPPORTED_KEYWORDS = new Set([
  'maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum',
  'multipleOf', 'pattern', 'format', 'uniqueItems',
])

export function apiJsonSchema(schema = TURN_RESPONSE_SCHEMA) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node == null || typeof node !== 'object') return node
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.has(k)) continue
      // A nullable enum ("string or null") is expressed as a union type upstream; structured
      // outputs are happier with the null dropped and the field simply left optional.
      if (k === 'enum' && Array.isArray(v)) { out[k] = v.filter((x) => x !== null); continue }
      if (k === 'type' && Array.isArray(v)) { out[k] = v.filter((t) => t !== 'null'); continue }
      out[k] = walk(v)
    }
    if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = false
    if (Array.isArray(out.type) && out.type.length === 1) out.type = out.type[0]
    return out
  }
  return walk(schema)
}
