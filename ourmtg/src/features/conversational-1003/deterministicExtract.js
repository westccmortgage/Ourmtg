// Conversational 1003 — deterministic extraction (no language model involved).
//
// WHY THIS EXISTS: the interview must still capture answers when the AI provider is missing,
// slow, refused, or returns something that fails the contract. Without this the engine saves
// the borrower's words but fills in nothing — the borrower types "March 2023" and watches the
// same question come back. That is a dead end, and §24 forbids dead ends.
//
// WHAT IT IS: the same normalizers the rest of the engine uses, pointed at the field that was
// actually asked. It is NOT an interpreter and does not pretend to be one:
//   • it only ever writes the field the question asked for (plus one tightly-scoped sibling)
//   • it never guesses across the catalog, never infers, never resolves ambiguity
//   • if the text does not parse cleanly as the asked type, it returns nothing
//
// So a borrower answering the question directly is captured with no provider at all. A borrower
// answering a *different* question than the one asked still needs the model — that is the part
// that requires real language understanding, and this module deliberately does not fake it.

import { getField, recordPrefix } from './applicationCatalog.js'
import {
  normalizeByType, normalizeFrequency, normalizeAmount, detectEstimateLanguage,
} from './normalization.js'

/**
 * @returns {Array<{fieldPath, rawText, normalizedCandidate, confidence, deterministic}>}
 */
export function deterministicExtract({ text, askedQuestion }) {
  const raw = String(text || '').trim()
  const path = askedQuestion?.fieldPath
  if (!raw || !path) return []

  const field = getField(path)
  // Secure and inference-forbidden fields are never written from conversational text — the
  // same rule the model is held to (§15/§26).
  if (!field || field.secureEntry || field.aiInferenceForbidden) return []

  const out = []
  const value = parseAs(field, raw)
  if (value != null) {
    out.push({
      fieldPath: path,
      rawText: raw,
      normalizedCandidate: value,
      // No confidence score: this is parsing, not interpretation. A number here would imply a
      // judgement nothing actually made.
      confidence: null,
      deterministic: true,
    })
  }

  // One tightly-scoped co-extraction: an income amount is unusable without its period, and
  // borrowers almost always say them together ("9,000 a month"). Capturing it here is what
  // stops the engine from having to ask a question the borrower already answered.
  if (field.section === 'income' && field.type === 'amount' && value != null) {
    const freq = normalizeFrequency(raw)
    if (freq.ok) {
      out.push({
        fieldPath: `${recordPrefix(path)}.frequency`,
        rawText: raw,
        normalizedCandidate: freq.value,
        confidence: null,
        deterministic: true,
      })
    }
  }

  return out
}

/**
 * Parse `raw` as the field's declared type. Conservative by design: anything that does not
 * parse unambiguously returns null so the planner re-asks rather than storing a guess.
 */
function parseAs(field, raw) {
  switch (field.type) {
    case 'enum': {
      const direct = normalizeByType('enum', raw, field)
      if (direct.ok) return direct.value
      // A single unambiguous keyword match. Two matches means the answer is ambiguous, and an
      // ambiguous answer must produce a question — not a coin flip.
      const hits = (field.values || []).filter((v) => keywordRe(v).test(raw))
      return hits.length === 1 ? hits[0] : null
    }
    case 'amount': {
      const r = normalizeAmount(raw)
      // Reject a bare year ("2023") being read as $2,023 when a date was clearly meant.
      if (r.ok && /^\s*(19|20)\d{2}\s*$/.test(raw)) return null
      return r.ok ? r.value : null
    }
    case 'boolean': case 'month': case 'date': case 'frequency': case 'percent':
    case 'integer': case 'phone': case 'email': case 'address': case 'year': {
      const r = normalizeByType(field.type, raw, field)
      return r.ok ? r.value : null
    }
    case 'name': case 'text': case 'longtext': {
      // Free text is accepted as given — but not when the borrower is plainly saying they do
      // not know, which is an intent the engine handles separately, not an employer name.
      if (looksLikeNonAnswer(raw)) return null
      const r = normalizeByType(field.type, raw, field)
      return r.ok ? r.value : null
    }
    default:
      return null
  }
}

const keywordRe = (enumValue) => new RegExp(`\\b${enumValue.replace(/_/g, '[ _-]?')}\\b`, 'i')

// Short phrases that are clearly not an answer to a free-text question.
const NON_ANSWER = /^(i\s+)?(don'?t|do not)\s+know|^не\s+знаю|^no\s+s[eé]|^n\/?a$|^\?+$|^idk$/i
const looksLikeNonAnswer = (s) => NON_ANSWER.test(s.trim())

/**
 * Wrap deterministic extractions in the same envelope a validated model interpretation uses, so
 * the engine has exactly one code path. `deterministic: true` marks the whole turn so the team
 * view and the turn log can tell parsing apart from interpretation.
 */
export function deterministicInterpretation({ text, askedQuestion }) {
  const extractions = deterministicExtract({ text, askedQuestion })
  if (!extractions.length) return null
  return {
    answerRelevance: 'direct',
    misunderstandingDetected: false,
    misunderstandingKind: null,
    plainLanguageExplanation: null,
    extractions,
    unmappedFacts: [],
    contradictions: [],
    clarificationTargets: [],
    safetyFlags: [],
    deterministic: true,
  }
}
