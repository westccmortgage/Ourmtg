// Conversational 1003 — deterministic normalization.
//
// The language model proposes a *candidate*; this module decides what that candidate really
// is. Every value that reaches storage passes through here, so parsing lives in one tested
// place and the model never performs arithmetic, date math, or unit conversion on its own.
//
// Pure. No I/O, no Date.now() in parsing paths (callers pass `today` when a relative date
// must be resolved) so tests are deterministic.

import { FREQUENCIES } from './types.js'

// ── Estimate detection ───────────────────────────────────────────────────────
// "around $8,000" must stay estimated until the borrower confirms it (§14, scenario 6).
// Matched against the borrower's ORIGINAL wording, in every supported language.
const ESTIMATE_MARKERS = [
  // en
  'about', 'around', 'approximately', 'approx', 'roughly', 'maybe', 'i think', 'i guess',
  'somewhere', 'ballpark', 'give or take', 'or so', 'close to', 'nearly', 'almost', 'like',
  // es
  'como', 'cerca de', 'aproximadamente', 'más o menos', 'mas o menos', 'creo que', 'unos',
  'unas', 'alrededor',
  // ru
  'около', 'примерно', 'приблизительно', 'где-то', 'порядка', 'думаю', 'наверное', 'что-то',
]

export function detectEstimateLanguage(raw) {
  const s = String(raw || '').toLowerCase()
  if (!s) return false
  if (/[~≈]/.test(s)) return true
  return ESTIMATE_MARKERS.some((m) => s.includes(m))
}

// Refusal vs. uncertainty are different states (§10 unsure_vs_refusal) — never conflate them.
const UNKNOWN_MARKERS = [
  "i don't know", 'i dont know', 'not sure', 'no idea', 'unsure', "i'm not sure", 'im not sure',
  'no sé', 'no se', 'no estoy seguro', 'no estoy segura',
  'не знаю', 'не уверен', 'не уверена',
]
const DECLINE_MARKERS = [
  'prefer not', 'rather not', 'do not wish', "don't wish", 'decline to', 'not comfortable',
  'no deseo', 'prefiero no', 'no quiero proporcionar',
  'не хочу', 'предпочитаю не', 'отказываюсь',
]
export function detectUnknown(raw) {
  const s = String(raw || '').toLowerCase()
  return UNKNOWN_MARKERS.some((m) => s.includes(m))
}
export function detectDecline(raw) {
  const s = String(raw || '').toLowerCase()
  return DECLINE_MARKERS.some((m) => s.includes(m))
}

// ── Amounts ──────────────────────────────────────────────────────────────────
// Handles: "$160,000" · "160k" · "8 000" · "96,000" · "1.088.000" (es/ru grouping) ·
// "1,088,000" · "8000.50". Returns { ok, value, estimated } — never throws.
const CURRENCY = /[$€₽£]|usd|dollars|dolares|dólares|руб|рублей/gi

export function normalizeAmount(raw) {
  if (raw == null || raw === '') return { ok: false, value: null, estimated: false }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0
      ? { ok: true, value: raw, estimated: false }
      : { ok: false, value: null, estimated: false }
  }
  const original = String(raw)
  const estimated = detectEstimateLanguage(original)
  let s = original.toLowerCase().replace(CURRENCY, ' ').trim()

  // "160k" / "160 тыс" / "160 mil" shorthand.
  let multiplier = 1
  const kMatch = s.match(/(\d[\d.,\s]*)\s*(k\b|тыс|mil\b)/)
  if (kMatch) { multiplier = 1000; s = kMatch[1] }

  // Keep only digits and separators, then decide which separator is decimal.
  const cleaned = (s.match(/-?[\d][\d.,\s ]*/) || [''])[0].replace(/[\s ]/g, '')
  if (!cleaned) return { ok: false, value: null, estimated }

  const value = parseGroupedNumber(cleaned)
  if (value == null || !Number.isFinite(value) || value < 0) {
    return { ok: false, value: null, estimated }
  }
  return { ok: true, value: round2(value * multiplier), estimated }
}

// Decide whether '.'/',' are grouping or decimal separators. A separator followed by exactly
// three digits AND appearing more than once, or with digits grouped in 3s, is grouping.
function parseGroupedNumber(cleaned) {
  const lastDot = cleaned.lastIndexOf('.')
  const lastComma = cleaned.lastIndexOf(',')
  const decimalSep = lastDot > lastComma ? '.' : lastComma > lastDot ? ',' : null
  if (decimalSep == null) return Number(cleaned)

  const tail = cleaned.slice(cleaned.lastIndexOf(decimalSep) + 1)
  const sepCount = (cleaned.match(new RegExp('\\' + decimalSep, 'g')) || []).length
  // ".000" or repeated separators → grouping, not a decimal point.
  const isGrouping = tail.length === 3 && (sepCount > 1 || /^\d{1,3}([.,]\d{3})+$/.test(cleaned))
  if (isGrouping) return Number(cleaned.replace(/[.,]/g, ''))
  const intPart = cleaned.slice(0, cleaned.lastIndexOf(decimalSep)).replace(/[.,]/g, '')
  return Number(`${intPart}.${tail}`)
}

const round2 = (n) => Math.round(n * 100) / 100

// ── Percent / integer ────────────────────────────────────────────────────────
export function normalizePercent(raw) {
  const m = String(raw ?? '').match(/-?\d+([.,]\d+)?/)
  if (!m) return { ok: false, value: null }
  const v = Number(m[0].replace(',', '.'))
  if (!Number.isFinite(v) || v < 0 || v > 100) return { ok: false, value: null }
  return { ok: true, value: round2(v), estimated: detectEstimateLanguage(raw) }
}

export function normalizeInteger(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return { ok: true, value: raw }
  const words = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
    ноль: 0, один: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 }
  const s = String(raw ?? '').toLowerCase().trim()
  if (words[s] !== undefined) return { ok: true, value: words[s] }
  const m = s.match(/\d+/)
  if (!m) return { ok: false, value: null }
  return { ok: true, value: Number(m[0]) }
}

// ── Dates and months ─────────────────────────────────────────────────────────
// Stems, longest-first, so "март" wins over the "ма" stem for май/мая/мае.
const MONTH_STEMS = [
  ['january', 1], ['enero', 1], ['январ', 1], ['jan', 1], ['ene', 1],
  ['february', 2], ['febrero', 2], ['феврал', 2], ['feb', 2],
  ['march', 3], ['marzo', 3], ['март', 3], ['mar', 3],
  ['april', 4], ['abril', 4], ['апрел', 4], ['apr', 4], ['abr', 4],
  ['mayo', 5], ['май', 5], ['мая', 5], ['мае', 5], ['may', 5],
  ['june', 6], ['junio', 6], ['июн', 6], ['jun', 6],
  ['july', 7], ['julio', 7], ['июл', 7], ['jul', 7],
  ['august', 8], ['agosto', 8], ['август', 8], ['aug', 8], ['ago', 8],
  ['september', 9], ['septiembre', 9], ['сентябр', 9], ['sep', 9],
  ['october', 10], ['octubre', 10], ['октябр', 10], ['oct', 10],
  ['november', 11], ['noviembre', 11], ['ноябр', 11], ['nov', 11],
  ['december', 12], ['diciembre', 12], ['декабр', 12], ['dec', 12], ['dic', 12],
].sort((a, b) => b[0].length - a[0].length)

const pad = (n) => String(n).padStart(2, '0')

// Returns { ok, value:'YYYY-MM', estimated } — the granularity the 1003 needs for employment
// and residence start dates. Rejects impossible months and implausible years.
export function normalizeMonth(raw) {
  if (raw == null || raw === '') return { ok: false, value: null }
  const s = String(raw).toLowerCase()
  const estimated = detectEstimateLanguage(s)

  // ISO first: 2024-03 / 2024-03-15
  const iso = s.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/)
  if (iso) {
    const y = Number(iso[1]); const mo = Number(iso[2])
    if (validYear(y) && mo >= 1 && mo <= 12) return { ok: true, value: `${y}-${pad(mo)}`, estimated }
    return { ok: false, value: null }
  }
  // Numeric: 3/2023 or 03/15/2023
  const numeric = s.match(/\b(\d{1,2})\s*[/.\-]\s*(?:(\d{1,2})\s*[/.\-]\s*)?(\d{4})\b/)
  if (numeric) {
    const mo = Number(numeric[1]); const y = Number(numeric[3])
    if (validYear(y) && mo >= 1 && mo <= 12) return { ok: true, value: `${y}-${pad(mo)}`, estimated }
    return { ok: false, value: null }
  }
  // Named month + year, in any supported language.
  const year = s.match(/\b(19|20)\d{2}\b/)
  const stem = MONTH_STEMS.find(([name]) => s.includes(name))
  if (stem && year) {
    const y = Number(year[0])
    if (!validYear(y)) return { ok: false, value: null }
    return { ok: true, value: `${y}-${pad(stem[1])}`, estimated }
  }
  // Year alone is NOT a month — the planner must ask for the month rather than assume January.
  return { ok: false, value: null, partial: year ? { year: Number(year[0]) } : null }
}

export function normalizeDate(raw) {
  if (raw == null || raw === '') return { ok: false, value: null }
  const s = String(raw)
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    return validCalendarDate(y, m, d) ? { ok: true, value: `${y}-${pad(m)}-${pad(d)}` } : { ok: false, value: null }
  }
  const us = s.match(/\b(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})\b/)
  if (us) {
    const [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])]
    return validCalendarDate(y, m, d) ? { ok: true, value: `${y}-${pad(m)}-${pad(d)}` } : { ok: false, value: null }
  }
  const named = s.toLowerCase()
  const stem = MONTH_STEMS.find(([name]) => named.includes(name))
  const year = named.match(/\b(19|20)\d{2}\b/)
  const day = named.match(/\b(\d{1,2})\b/)
  if (stem && year && day) {
    const y = Number(year[0]); const d = Number(day[1])
    return validCalendarDate(y, stem[1], d)
      ? { ok: true, value: `${y}-${pad(stem[1])}-${pad(d)}` } : { ok: false, value: null }
  }
  return { ok: false, value: null }
}

function validYear(y) { return Number.isInteger(y) && y >= 1900 && y <= 2100 }
function validCalendarDate(y, m, d) {
  if (!validYear(y) || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

// ── Durations ────────────────────────────────────────────────────────────────
// "2 years", "18 months", "год и 6 месяцев", "dos años" → whole months.
export function normalizeDurationMonths(raw) {
  const s = String(raw ?? '').toLowerCase()
  if (!s) return { ok: false, value: null }
  let months = 0
  let found = false
  const yearM = s.match(/(\d+(?:[.,]\d+)?)\s*(years?|yrs?|años?|anos?|лет|год[аy]?|года|год)/)
  if (yearM) { months += Math.round(Number(yearM[1].replace(',', '.')) * 12); found = true }
  const monthM = s.match(/(\d+(?:[.,]\d+)?)\s*(months?|mos?\b|meses|mes\b|месяц[аевы]*)/)
  if (monthM) { months += Math.round(Number(monthM[1].replace(',', '.'))); found = true }
  if (!found) return { ok: false, value: null }
  return { ok: true, value: months, estimated: detectEstimateLanguage(s) }
}

// ── Frequency ────────────────────────────────────────────────────────────────
// JS \b is ASCII-only, so it never fires next to Cyrillic. Build Unicode-aware boundaries
// instead — otherwise "в месяц" silently fails to match and the borrower gets re-asked.
const bounded = (alts) => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, 'u')

// Order matters: the more specific compounds (biweekly, semimonthly) must be tested before
// the plain "week"/"month" patterns they contain.
const FREQUENCY_PATTERNS = [
  [bounded('bi-?weekly|every two weeks|every other week|cada dos semanas|раз в две недели'), 'biweekly'],
  [bounded('semi-?monthly|twice a month|twice per month|dos veces al mes|два раза в месяц'), 'semimonthly'],
  [bounded('hourly|hour|per hour|an hour|hora|por hora|час|в час|почасово'), 'hourly'],
  [bounded('weekly|week|per week|a week|semana|por semana|неделя|неделю|в неделю|еженедельно'), 'weekly'],
  [bounded('monthly|month|per month|a month|mensual|al mes|por mes|месяц|месяца|в месяц|ежемесячно'), 'monthly'],
  [bounded('quarterly|quarter|per quarter|trimestral|квартал|в квартал|ежеквартально'), 'quarterly'],
  [bounded('annually|annual|yearly|year|per year|a year|anual|al año|год|году|в год|ежегодно'), 'annual'],
  [bounded('one-?time|lump sum|once|una vez|единовременно|разово'), 'one_time'],
]

export function normalizeFrequency(raw) {
  if (raw == null || raw === '') return { ok: false, value: null }
  const s = String(raw).toLowerCase().trim()
  if (FREQUENCIES.includes(s)) return { ok: true, value: s }
  for (const [re, freq] of FREQUENCY_PATTERNS) if (re.test(s)) return { ok: true, value: freq }
  return { ok: false, value: null }
}

// The ONLY frequency→monthly conversion in the system. Deterministic factors; hourly is
// deliberately NOT convertible without hours-per-week, so it returns ok:false rather than
// inventing a 40-hour assumption.
const MONTHLY_FACTOR = {
  weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, quarterly: 1 / 3, annual: 1 / 12,
}
export function monthlyEquivalent(amount, frequency, { hoursPerWeek = null } = {}) {
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt < 0) return { ok: false, value: null }
  if (frequency === 'one_time') return { ok: false, value: null, reason: 'one_time_not_recurring' }
  if (frequency === 'hourly') {
    if (!Number.isFinite(Number(hoursPerWeek)) || Number(hoursPerWeek) <= 0) {
      return { ok: false, value: null, reason: 'hours_per_week_required' }
    }
    return { ok: true, value: round2(amt * Number(hoursPerWeek) * (52 / 12)) }
  }
  const f = MONTHLY_FACTOR[frequency]
  if (!f) return { ok: false, value: null }
  return { ok: true, value: round2(amt * f) }
}

// ── Text-ish types ───────────────────────────────────────────────────────────
// Names, employer names, and addresses are stored VERBATIM (trimmed only). They are never
// translated or "corrected" — §17 forbids it.
export function normalizeText(raw, max = 200) {
  if (raw == null) return { ok: false, value: null }
  const s = String(raw).replace(/\s+/g, ' ').trim().slice(0, max)
  return s ? { ok: true, value: s } : { ok: false, value: null }
}

export function normalizeBoolean(raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  const s = String(raw ?? '').toLowerCase().trim()
  if (/^(yes|y|true|sí|si|s|да|д)\b/.test(s)) return { ok: true, value: true }
  if (/^(no|n|false|нет|н)\b/.test(s)) return { ok: true, value: false }
  return { ok: false, value: null }
}

export function normalizeEnum(raw, allowed = []) {
  if (raw == null) return { ok: false, value: null }
  const s = String(raw).trim()
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase())
  return hit ? { ok: true, value: hit } : { ok: false, value: null }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
export function normalizeEmailValue(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  return EMAIL_RE.test(s) ? { ok: true, value: s } : { ok: false, value: null }
}

export function normalizePhoneValue(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return digits.length === 10 ? { ok: true, value: digits } : { ok: false, value: null }
}

// Addresses stay free-text at MVP (a full USPS/parsed-address model is out of scope and
// documented as such); we only require enough substance to be a plausible street address.
export function normalizeAddress(raw) {
  const t = normalizeText(raw, 300)
  if (!t.ok) return { ok: false, value: null }
  if (t.value.length < 6 || !/\d/.test(t.value)) return { ok: false, value: null, reason: 'incomplete_address' }
  return { ok: true, value: t.value }
}

// ── Month arithmetic used by the history rules (§12) ─────────────────────────
export function monthToIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''))
  if (!m) return null
  return Number(m[1]) * 12 + (Number(m[2]) - 1)
}
export function indexToMonth(idx) {
  if (!Number.isInteger(idx)) return null
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`
}
export function monthsBetween(startYm, endYm) {
  const a = monthToIndex(startYm); const b = monthToIndex(endYm)
  if (a == null || b == null) return null
  return b - a
}

// Dispatch table used by the reducer: type → normalizer.
export const NORMALIZERS = Object.freeze({
  text: (v) => normalizeText(v, 200),
  longtext: (v) => normalizeText(v, 4000),
  name: (v) => normalizeText(v, 120),
  email: normalizeEmailValue,
  phone: normalizePhoneValue,
  address: normalizeAddress,
  date: normalizeDate,
  month: normalizeMonth,
  year: (v) => {
    const m = String(v ?? '').match(/\b(19|20)\d{2}\b/)
    return m && validYear(Number(m[0])) ? { ok: true, value: Number(m[0]) } : { ok: false, value: null }
  },
  amount: normalizeAmount,
  percent: normalizePercent,
  integer: normalizeInteger,
  boolean: normalizeBoolean,
  frequency: normalizeFrequency,
  // Sensitive types are NEVER normalized from conversational text (§15). The secure-input
  // endpoint validates them server-side; a conversational candidate is always rejected.
  ssn: () => ({ ok: false, value: null, reason: 'secure_entry_required' }),
  account_number: () => ({ ok: false, value: null, reason: 'secure_entry_required' }),
})

export function normalizeByType(type, raw, field = {}) {
  if (type === 'enum') return normalizeEnum(raw, field.values || [])
  const fn = NORMALIZERS[type]
  if (!fn) return { ok: false, value: null, reason: 'unknown_type' }
  return fn(raw)
}
