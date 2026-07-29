// Conversational 1003 — misunderstanding detection and recovery (§10).
//
// This is the behavior the product exists for. When the borrower answers a *different*
// question than the one asked, we must (a) keep everything useful they said, (b) never imply
// they got it wrong, (c) explain the concept in plain language, and (d) ask one precise
// follow-up.
//
// Detection is DETERMINISTIC: it compares what was asked against what was actually extracted.
// The model may also report `misunderstandingDetected`, but that report is only ever a hint —
// this module decides, so a hallucinated or missing model flag cannot change behavior.

import { getField, chipLabel } from './applicationCatalog.js'
import { normalizeDurationMonths, normalizeAmount, normalizeFrequency } from './normalization.js'

// Did the borrower state a period in their own words, even if nothing was extracted for it?
const frequencyStated = (text) => normalizeFrequency(text).ok

const DATE_TYPES = new Set(['month', 'date', 'year'])

/**
 * Decide whether the borrower's answer missed the asked question, and why.
 *
 * @param {object} args
 *   askedPath      instantiated path of the field the question targeted (null for open turns)
 *   extractions    accepted extractions from this turn: [{ path, value, type }]
 *   originalText   the borrower's own words
 * @returns {{ kind:string|null, askedPath:string|null, captured:string[], stillMissing:boolean }}
 */
export function detectMisunderstanding({ askedPath, extractions = [], originalText = '' }) {
  if (!askedPath) return { kind: null, askedPath: null, captured: [], stillMissing: false }
  const asked = getField(askedPath)
  if (!asked) return { kind: null, askedPath, captured: [], stillMissing: false }

  const answeredAsked = extractions.some((e) => e.path === askedPath)
  const captured = extractions.map((e) => e.path)
  const gotSections = new Set(extractions.map((e) => getField(e.path)?.section).filter(Boolean))
  const gotTypes = new Set(extractions.map((e) => getField(e.path)?.type).filter(Boolean))
  const text = String(originalText || '')

  // The borrower DID answer, but the answer is ambiguous on its own. "I make 96,000" is a
  // real answer to "how much?" — and it is unusable until we know the period. Flagging it
  // here is what makes the engine ask instead of assuming (§28.5).
  if (answeredAsked) {
    const asksIncomeAmount = asked.section === 'income' && asked.type === 'amount'
    const gotFrequency = extractions.some((e) => getField(e.path)?.type === 'frequency')
    if (asksIncomeAmount && !gotFrequency && !frequencyStated(text)) {
      return { kind: 'monthly_vs_annual', askedPath, captured, stillMissing: true, ambiguous: true }
    }
    if (asked.section === 'income' && /\b(take[- ]home|after tax|net pay|neto|на руки|чистыми)/i.test(text)) {
      return { kind: 'gross_vs_net_income', askedPath, captured, stillMissing: true, ambiguous: true }
    }
    return { kind: null, askedPath, captured, stillMissing: false }
  }

  // A date/month was asked and the borrower gave money or a length of time instead.
  if (DATE_TYPES.has(asked.type)) {
    const duration = normalizeDurationMonths(text)
    const amount = normalizeAmount(text)
    if (gotTypes.has('amount') || amount.ok) {
      return { kind: 'duration_vs_amount', askedPath, captured, stillMissing: true }
    }
    if (duration.ok) {
      return { kind: 'start_date_vs_years_employed', askedPath, captured, stillMissing: true }
    }
  }

  // An amount was asked and we could not pin the period it covers.
  if (asked.type === 'amount' && asked.section === 'income') {
    const hasFrequency = extractions.some((e) => getField(e.path)?.type === 'frequency')
    if (!hasFrequency && /\d/.test(text)) {
      return { kind: 'monthly_vs_annual', askedPath, captured, stillMissing: true }
    }
  }

  // Asset balance asked, income offered (and vice versa).
  if (asked.section === 'assets' && asked.type === 'amount' && gotSections.has('income')) {
    return { kind: 'asset_balance_vs_income', askedPath, captured, stillMissing: true }
  }
  if (asked.section === 'income' && asked.type === 'amount' && gotSections.has('assets')) {
    return { kind: 'asset_balance_vs_income', askedPath, captured, stillMissing: true }
  }

  // Employer name asked, only a job title captured.
  if (askedPath.endsWith('.employerName') && captured.some((p) => p.endsWith('.position'))) {
    return { kind: 'employer_vs_occupation', askedPath, captured, stillMissing: true }
  }
  // Property value vs what is still owed.
  if ((askedPath.endsWith('.propertyValue') || askedPath === 'loan.estimatedPropertyValue')
      && captured.some((p) => p.endsWith('mortgageBalance') || p === 'loan.existingLoanBalance')) {
    return { kind: 'value_vs_mortgage_balance', askedPath, captured, stillMissing: true }
  }
  // Loan amount vs purchase price.
  if (askedPath === 'loan.requestedLoanAmount' && captured.includes('loan.purchasePrice')) {
    return { kind: 'loan_amount_vs_purchase_price', askedPath, captured, stillMissing: true }
  }
  // Housing payment asked, a tax figure offered.
  if (askedPath.endsWith('.monthlyHousingExpense') && /\b(tax|impuesto|налог)/i.test(text)) {
    return { kind: 'rent_vs_property_tax', askedPath, captured, stillMissing: true }
  }
  // Current address asked, mailing address described.
  if (askedPath.includes('.residence[') && /\b(mail|p\.?o\.? box|correo|почт)/i.test(text)) {
    return { kind: 'current_vs_mailing_address', askedPath, captured, stillMissing: true }
  }
  // Gross vs take-home.
  if (asked.section === 'income' && /\b(take[- ]home|after tax|net pay|neto|на руки|чистыми)/i.test(text)) {
    return { kind: 'gross_vs_net_income', askedPath, captured, stillMissing: true }
  }

  // Something useful was captured, just not the asked field.
  if (extractions.length > 0) {
    return { kind: 'unrelated_but_useful', askedPath, captured, stillMissing: true }
  }
  return { kind: null, askedPath, captured, stillMissing: true }
}

// ── Recovery copy ────────────────────────────────────────────────────────────
// Deterministic templates. The AI provider MAY produce warmer wording, but these are what
// ship when the provider is slow, down, or returns something that fails validation — so the
// borrower never sees a dead end. Never blames the borrower; always names what was saved.

const RECOVERY = {
  duration_vs_amount: {
    en: {
      concept: 'For this question I need a date — the month and year you began — rather than an amount.',
      example: 'For example: "March 2023" or "03/2023".',
    },
    es: {
      concept: 'Para esta pregunta necesito una fecha — el mes y el año en que empezó — no una cantidad.',
      example: 'Por ejemplo: "marzo de 2023" o "03/2023".',
    },
    ru: {
      concept: 'Для этого вопроса нужна дата — месяц и год начала работы, а не сумма.',
      example: 'Например: «март 2023» или «03/2023».',
    },
  },
  start_date_vs_years_employed: {
    en: { concept: 'I need the month and year you started, rather than how long you have been there.', example: 'If it has been about two years, the start date might be "July 2024".' },
    es: { concept: 'Necesito el mes y año en que empezó, no cuánto tiempo lleva.', example: 'Si lleva unos dos años, la fecha podría ser "julio de 2024".' },
    ru: { concept: 'Нужен месяц и год начала работы, а не стаж.', example: 'Если прошло около двух лет, дата может быть «июль 2024».' },
  },
  monthly_vs_annual: {
    en: { concept: 'I need to know the period that amount covers, because monthly and yearly are very different numbers.', example: 'Is that per month, or per year?' },
    es: { concept: 'Necesito saber el período que cubre esa cantidad; mensual y anual son muy distintos.', example: '¿Es por mes o por año?' },
    ru: { concept: 'Нужно знать период, за который указана сумма — в месяц и в год это очень разные числа.', example: 'Это в месяц или в год?' },
  },
  asset_balance_vs_income: {
    en: { concept: 'Here I am asking about money you already have saved — a balance in an account — rather than money you receive regularly.', example: 'For example, the balance showing in your checking account today.' },
    es: { concept: 'Aquí pregunto por dinero que ya tiene ahorrado — un saldo — no por ingresos que recibe.', example: 'Por ejemplo, el saldo de su cuenta corriente hoy.' },
    ru: { concept: 'Здесь речь о накопленных средствах — остатке на счёте, а не о регулярном доходе.', example: 'Например, текущий остаток на расчётном счёте.' },
  },
  employer_vs_occupation: {
    en: { concept: 'I have your job title. For this question I need the name of the company that pays you.', example: 'For example: "ABC Construction, Inc."' },
    es: { concept: 'Ya tengo su puesto. Aquí necesito el nombre de la empresa que le paga.', example: 'Por ejemplo: "ABC Construction, Inc."' },
    ru: { concept: 'Должность записана. Здесь нужно название компании-работодателя.', example: 'Например: «ABC Construction, Inc.»' },
  },
  value_vs_mortgage_balance: {
    en: { concept: 'These are two different numbers: what the property is worth, and what you still owe on it.', example: 'Right now I need what you think it would sell for today.' },
    es: { concept: 'Son dos números distintos: cuánto vale la propiedad y cuánto debe todavía.', example: 'Ahora necesito por cuánto cree que se vendería hoy.' },
    ru: { concept: 'Это два разных числа: стоимость объекта и остаток долга по нему.', example: 'Сейчас нужна предполагаемая рыночная стоимость.' },
  },
  loan_amount_vs_purchase_price: {
    en: { concept: 'The purchase price is what you pay for the home; the loan amount is what you borrow after your down payment.', example: 'For a $600,000 home with $60,000 down, the loan amount would be $540,000.' },
    es: { concept: 'El precio es lo que paga por la casa; el préstamo es lo que pide después del enganche.', example: 'Casa de $600,000 con $60,000 de enganche: préstamo de $540,000.' },
    ru: { concept: 'Цена — это стоимость дома; сумма кредита — то, что вы занимаете после первоначального взноса.', example: 'Дом за $600,000 и взнос $60,000 — кредит $540,000.' },
  },
  rent_vs_property_tax: {
    en: { concept: 'I need your total monthly housing payment, not the property tax on its own.', example: 'If you rent, that is your rent. If you own, it is the full mortgage payment.' },
    es: { concept: 'Necesito el pago total de vivienda al mes, no solo el impuesto predial.', example: 'Si alquila, es su renta. Si es dueño, el pago hipotecario completo.' },
    ru: { concept: 'Нужен полный ежемесячный платёж за жильё, а не только налог на недвижимость.', example: 'При аренде — арендная плата; при владении — полный ипотечный платёж.' },
  },
  current_vs_mailing_address: {
    en: { concept: 'Your mailing address and the address where you actually live are separate questions — I will ask about mail next.', example: 'Right now I need the street address where you physically live.' },
    es: { concept: 'La dirección postal y donde vive son preguntas distintas; preguntaré por el correo después.', example: 'Ahora necesito la dirección donde vive físicamente.' },
    ru: { concept: 'Почтовый адрес и адрес проживания — разные вопросы; про почту спрошу отдельно.', example: 'Сейчас нужен адрес фактического проживания.' },
  },
  gross_vs_net_income: {
    en: { concept: 'Lenders use your gross pay — the amount before taxes and deductions — not your take-home pay.', example: 'It is the larger number on your pay stub, before anything is taken out.' },
    es: { concept: 'Los prestamistas usan el ingreso bruto, antes de impuestos, no lo que recibe neto.', example: 'Es el número mayor en su recibo de pago, antes de deducciones.' },
    ru: { concept: 'Кредиторы используют доход до вычета налогов, а не сумму «на руки».', example: 'Это большее число в расчётном листке, до удержаний.' },
  },
  unrelated_but_useful: {
    en: { concept: 'That belongs to a different part of the application, so I saved it there.', example: '' },
    es: { concept: 'Eso pertenece a otra parte de la solicitud, así que lo guardé allí.', example: '' },
    ru: { concept: 'Это относится к другой части заявки — я сохранил информацию там.', example: '' },
  },
}

// "I saved X as possible Y" — states plainly that the value was kept AND that it is not yet
// treated as an answer, which is the honest description of an unconfirmed candidate.
const ACK = {
  en: (n) => (n ? `Thank you — I saved ${n}.` : 'Thank you.'),
  es: (n) => (n ? `Gracias — guardé ${n}.` : 'Gracias.'),
  ru: (n) => (n ? `Спасибо — я сохранил ${n}.` : 'Спасибо.'),
}

/**
 * Build the recovery message. Returns { text, parts } — `parts` lets the UI render the
 * acknowledgement, explanation, and follow-up as separate elements.
 *
 * NOTE the ordering required by §10: acknowledge → explain → ask. It never contains the
 * words "incorrect", "wrong", or "invalid".
 */
export function buildRecovery({ kind, locale = 'en', savedSummary = '', followUpQuestion = '' }) {
  const lang = RECOVERY[kind] ? (RECOVERY[kind][locale] ? locale : 'en') : 'en'
  const copy = RECOVERY[kind]?.[lang] || RECOVERY.unrelated_but_useful[lang] || RECOVERY.unrelated_but_useful.en
  const ack = (ACK[locale] || ACK.en)(savedSummary)
  const parts = {
    acknowledgement: ack,
    explanation: copy.concept,
    example: copy.example || '',
    question: followUpQuestion || '',
  }
  const text = [parts.acknowledgement, parts.explanation, parts.example, parts.question]
    .filter(Boolean).join(' ')
  return { text, parts, kind, locale }
}

const AS_POSSIBLE = {
  en: (value, label) => `${value} as possible ${label}`,
  es: (value, label) => `${value} como posible ${label}`,
  ru: (value, label) => `${value} как возможный ${label}`,
}

/**
 * Human-readable summary of what was saved, for the acknowledgement line — e.g.
 * "$160,000 as possible income amount". Uses the short chip label, never the question text.
 */
export function summarizeSaved(extractions, locale = 'en') {
  const fmt = AS_POSSIBLE[locale] || AS_POSSIBLE.en
  const named = extractions
    .map((e) => {
      if (!getField(e.path)) return null
      return fmt(String(e.displayValue ?? e.value), chipLabel(e.path, locale))
    })
    .filter(Boolean)
  if (!named.length) return ''
  if (named.length === 1) return named[0]
  const joiner = { en: 'and', es: 'y', ru: 'и' }[locale] || 'and'
  return `${named.slice(0, -1).join(', ')} ${joiner} ${named[named.length - 1]}`
}

/** Convenience used by tests and the engine: is `text` free of blame language? */
export function isBlameFree(text) {
  return !/\b(incorrect|wrong|invalid|error|mistake|failed)\b/i.test(String(text || ''))
}
