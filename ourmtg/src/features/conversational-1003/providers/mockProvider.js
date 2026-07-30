// Conversational 1003 — deterministic MOCK provider.
//
// SCOPE: tests, local development, and CI. It is NOT a production interpreter and the server
// refuses to select it when the live provider is required (see conversational1003.mjs).
// §29 forbids hardcoded fake AI responses in the production path — this file exists so the
// engine can be exercised end-to-end without a vendor, not to imitate one in front of a
// borrower.
//
// It uses the same deterministic parsers the engine uses, so what it "extracts" is real
// parsing of the borrower's text — just without any language understanding beyond patterns.

import { assertProvider } from './providerInterface.js'
import { getField } from '../applicationCatalog.js'
import {
  normalizeAmount, normalizeMonth, normalizeFrequency, normalizeBoolean, normalizeEnum,
  normalizeDurationMonths, normalizeText,
} from '../normalization.js'

const MONEY_RE = /(?:[$€₽]\s*)?\d[\d.,\s]*(?:\s*(?:k|тыс|mil))?/gi

export function createMockProvider({ modelVersion = 'mock-1' } = {}) {
  return assertProvider({
    name: 'mock',
    modelVersion,

    async interpretTurn({ text, context }) {
      const allowed = new Set(context?.allowedFieldPaths || [])
      const askedPath = context?.askedQuestion?.fieldPath || null
      const extractions = []
      const push = (fieldPath, candidate, rawText, confidence = 0.75) => {
        if (!allowed.has(fieldPath)) return
        if (extractions.some((e) => e.fieldPath === fieldPath)) return
        extractions.push({ fieldPath, rawText, normalizedCandidate: candidate, confidence })
      }

      // 1) Try to answer the asked field directly, using its declared type.
      if (askedPath) {
        const direct = parseForField(askedPath, text)
        if (direct != null) push(askedPath, direct, text, 0.9)
      }

      // 2) Out-of-order facts the borrower volunteered (§9). Keyword-anchored so the mock does
      //    not scatter every number across every money field.
      for (const [re, path] of contextualPatterns(context)) {
        if (!allowed.has(path)) continue
        const m = re.exec(text)
        if (!m) continue
        const val = parseForField(path, m[0])
        if (val != null) push(path, val, m[0], 0.6)
      }

      // 3) A bare amount when an amount was asked but step 1 found nothing usable.
      if (askedPath && !extractions.length) {
        const f = getField(askedPath)
        if (f?.type === 'amount') {
          const amt = normalizeAmount(text)
          if (amt.ok) push(askedPath, amt.value, text, 0.5)
        }
      }

      const answeredAsked = extractions.some((e) => e.fieldPath === askedPath)
      return {
        answerRelevance: answeredAsked ? (extractions.length > 1 ? 'partial' : 'direct')
          : extractions.length ? 'unrelated' : 'unclear',
        misunderstandingDetected: Boolean(askedPath) && !answeredAsked,
        plainLanguageExplanation: null,
        extractions,
        unmappedFacts: [],
        contradictions: [],
        clarificationTargets: [],
        safetyFlags: [],
      }
    },

    async explainQuestion({ question }) {
      return { text: question?.why || '' }
    },
    async renderNextQuestion({ question }) {
      return { text: question?.prompt || '' }
    },
    async summarizeReview({ report }) {
      const open = report?.openFields?.length ?? 0
      return { text: open === 0 ? 'Everything required has been answered.' : `${open} item(s) still need your attention.` }
    },
  })
}

// Parse `text` as the declared type of `fieldPath`. Returns null when it does not parse —
// the mock never guesses, which is what makes the misunderstanding tests meaningful.
function parseForField(fieldPath, text) {
  const f = getField(fieldPath)
  if (!f) return null
  switch (f.type) {
    case 'amount': {
      const r = normalizeAmount(text)
      return r.ok ? r.value : null
    }
    case 'month': {
      const r = normalizeMonth(text)
      return r.ok ? r.value : null
    }
    case 'frequency': {
      const r = normalizeFrequency(text)
      return r.ok ? r.value : null
    }
    case 'boolean': {
      const r = normalizeBoolean(text)
      return r.ok ? r.value : null
    }
    case 'integer': {
      const m = String(text).match(/\d+/)
      return m ? Number(m[0]) : null
    }
    case 'percent': {
      const m = String(text).match(/(\d+(?:[.,]\d+)?)\s*%/)
      return m ? Number(m[1].replace(',', '.')) : null
    }
    case 'enum': {
      const r = normalizeEnum(text, f.values || [])
      if (r.ok) return r.value
      // Accept an unambiguous keyword match for a single enum value.
      const hits = (f.values || []).filter((v) => new RegExp(v.replace(/_/g, '[ _-]?'), 'i').test(text))
      return hits.length === 1 ? hits[0] : null
    }
    case 'address': case 'text': case 'name': case 'longtext': {
      const r = normalizeText(text, 200)
      return r.ok ? r.value : null
    }
    default:
      return null
  }
}

// Keyword-anchored extraction of facts stated alongside the answer.
function contextualPatterns(context) {
  const p0 = 'parties[0]'
  const known = context?.known || []
  const nextIdx = (group) => {
    const used = known.map((k) => k.fieldPath).filter((f) => f.includes(`.${group}[`))
    const idxs = used.map((f) => Number(/\[(\d+)\]/.exec(f.split(`.${group}`)[1])?.[1] ?? 0))
    return idxs.length ? Math.max(...idxs) : 0
  }
  const inc = nextIdx('income')
  return [
    [new RegExp(`(?:bonus|bono|бонус)[^.]{0,40}?${MONEY_RE.source}`, 'i'), `${p0}.income[${inc + 1}].amount`],
    [new RegExp(`${MONEY_RE.source}[^.]{0,20}?(?:bonus|bono|бонус)`, 'i'), `${p0}.income[${inc + 1}].amount`],
    [/(?:started|start|began|empec|начал)[^.]{0,40}?(?:\d{1,2}[/.-]\d{4}|\d{4}-\d{2}|[A-Za-zА-Яа-я]{3,12}\s+\d{4})/i, `${p0}.employment[0].startDate`],
    [new RegExp(`(?:purchase price|price of|precio|цена)[^.]{0,30}?${MONEY_RE.source}`, 'i'), 'loan.purchasePrice'],
    [new RegExp(`(?:down ?payment|enganche|взнос)[^.]{0,30}?${MONEY_RE.source}`, 'i'), 'loan.downPaymentAmount'],
  ]
}

/** Used by the server to refuse the mock in a live borrower path. */
export const MOCK_PROVIDER_NAME = 'mock'
