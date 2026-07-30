// Conversational 1003 — the deterministic question planner (§11).
//
// The planner decides WHAT to ask. The model may only re-word what the planner chose; it can
// never change requiredness, skip a field, or declare the interview finished.
//
// Priority order (fixed):
//   1. a contradiction blocking a section
//   2. a required clarification
//   3. the currently active logical group (finish what we started)
//   4. missing high-impact fields
//   5. missing dependent details
//   6. optional information
//   7. final review
//
// Loop safety: every question carries a stable id and an attempt counter. Repeated confusion
// escalates the *presentation* (simplify → examples → structured input → offer the team); it
// never re-sends identical wording forever.

import { getField, SECTION_LABELS, instantiate } from './applicationCatalog.js'
import { computeCompleteness, GROUPS } from './completenessEngine.js'
import { fieldValue, groupIndices } from './applicationReducer.js'

// Section order for step 3/4 — identity first (cheap, builds momentum), money later.
const SECTION_ORDER = [
  'loan', 'identity', 'residence', 'employment', 'income', 'assets',
  'liabilities', 'reo', 'declarations', 'demographics', 'supplemental',
]

// Within a repeating record, ask in an order that unlocks the conditional rules first
// (isCurrent/type gate half the other fields).
const FIELD_ORDER_HINT = [
  'purpose', 'occupancy', 'isUnderContract',
  'assetType', 'liabilityType', 'incomeType', 'employmentType', 'occupancyBasis',
  'isCurrent', 'employerName', 'position', 'startDate', 'endDate',
  'institutionName', 'creditorName', 'street', 'city', 'state', 'postalCode',
  'amount', 'frequency', 'balance', 'monthlyPayment', 'unpaidBalance',
]

const orderHint = (path) => {
  const leaf = path.split('.').pop().replace(/\[\d+\]/, '')
  const i = FIELD_ORDER_HINT.indexOf(leaf)
  return i === -1 ? FIELD_ORDER_HINT.length : i
}

export const MAX_ATTEMPTS_BEFORE_ESCALATION = 3

/**
 * Choose the next thing to ask.
 *
 * @param state    application state (applicationReducer)
 * @param ctx      { asOfMonth, locale, askedHistory, activeGroup, attested, teamAccepted }
 *                 askedHistory: { [questionId]: { attempts, lastAskedAt, confused, skipped } }
 * @returns a Question object, or a 'review' / 'complete' terminal step.
 */
export function planNextQuestion(state, ctx = {}) {
  const {
    asOfMonth, locale = 'en', askedHistory = {}, activeGroup = null,
    attested = false, teamAccepted = false,
  } = ctx
  const report = computeCompleteness(state, { asOfMonth, attested, teamAccepted })

  // 1 — contradictions block everything in their section.
  const conflict = report.conflicts.find((c) => !isSkipped(askedHistory, conflictId(c.path)))
  if (conflict) return conflictQuestion(conflict, { locale, askedHistory })

  // 2 — required clarifications.
  const clarify = report.clarifications.find((c) => !isSkipped(askedHistory, fieldId(c.path)))
  if (clarify) return fieldQuestion(clarify.path, { locale, askedHistory, reason: 'clarification', state })

  // 3/4/5 — structural gaps and open fields, ordered.
  // Order within a section: start a missing first record (0) → fill the fields of records that
  // already exist (1) → only then extend history backwards (2). Asking "where did you work
  // before that?" while the current job is half-filled is the wrong question.
  const structuralOrder = (kind) => (kind === 'min_records' ? 0 : 2)
  // A field holding an unconfirmed candidate has BEEN answered — it is waiting on a
  // confirmation, not on another asking. Re-asking it would loop forever, so it is excluded
  // here and surfaced as a confirmation step below.
  const unanswered = report.openFields.filter((o) => o.status !== 'candidate')
  const candidates = [
    ...report.structural.map((s) => ({ kind: 'structural', s, section: s.group, order: structuralOrder(s.kind) })),
    ...unanswered.map((o) => ({ kind: 'field', o, section: o.section, order: 1 })),
  ]
    .filter((c) => !isSkipped(askedHistory, c.kind === 'field' ? fieldId(c.o.path) : structuralId(c.s)))
    .sort(byPriority(activeGroup))

  if (candidates.length) {
    const top = candidates[0]
    return top.kind === 'structural'
      ? structuralQuestion(top.s, { locale, askedHistory, state })
      : fieldQuestion(top.o.path, { locale, askedHistory, state })
  }

  // 6 — values captured but still awaiting the borrower's explicit confirmation (§14).
  const pending = report.openFields.filter((o) => o.status === 'candidate')
  if (pending.length) {
    return {
      type: 'confirm',
      id: `confirm:${pending.map((p) => p.path).join('|')}`.slice(0, 200),
      locale,
      items: pending.map((p) => {
        const f = getField(p.path)
        return {
          path: p.path,
          label: pick(f?.label, locale),
          displayValue: state.fields[p.path]?.display_value ?? null,
          estimated: Boolean(state.fields[p.path]?.estimated),
        }
      }),
      prompt: pick(PENDING_CONFIRM_COPY.prompt, locale),
      why: pick(PENDING_CONFIRM_COPY.why, locale),
      report,
    }
  }

  // 7 — review / attestation.
  if (!attested) return { type: 'review', id: 'review', locale, report }
  return { type: 'complete', id: 'complete', locale, report }
}

function byPriority(activeGroup) {
  return (a, b) => {
    // Finish the group we are already inside.
    const aActive = activeGroup && a.section === activeGroup ? 0 : 1
    const bActive = activeGroup && b.section === activeGroup ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    // Structural gaps (a whole missing record) before individual fields in the same section.
    if (a.section === b.section && a.order !== b.order) return a.order - b.order
    const as = SECTION_ORDER.indexOf(a.section); const bs = SECTION_ORDER.indexOf(b.section)
    if (as !== bs) return (as === -1 ? 99 : as) - (bs === -1 ? 99 : bs)
    // High-impact fields first within a section, then the record-order hint.
    const ah = a.kind === 'field' && getField(a.o.path)?.highImpact ? 0 : 1
    const bh = b.kind === 'field' && getField(b.o.path)?.highImpact ? 0 : 1
    if (ah !== bh) return ah - bh
    const ao = a.kind === 'field' ? orderHint(a.o.path) : -1
    const bo = b.kind === 'field' ? orderHint(b.o.path) : -1
    return ao - bo
  }
}

// ── Question builders ────────────────────────────────────────────────────────

const fieldId = (path) => `field:${path}`
const structuralId = (s) => `struct:${s.kind}:${s.partyIndex}:${s.group}`
const conflictId = (path) => `conflict:${path}`
const isSkipped = (hist, id) => Boolean(hist[id]?.skipped)

function attemptsFor(hist, id) { return hist[id]?.attempts || 0 }

/**
 * Escalation ladder (§11). Never repeats identical wording indefinitely:
 *   0 → normal wording
 *   1 → simplified wording + explanation
 *   2 → examples / selectable choices
 *   3+ → offer structured input and the loan team
 */
export function escalationFor(attempts, confused = 0) {
  const level = Math.max(attempts, confused)
  if (level <= 0) return 'normal'
  if (level === 1) return 'simplified'
  if (level === 2) return 'examples'
  return 'assisted'
}

function fieldQuestion(path, { locale, askedHistory, state, reason = null, optional = false }) {
  const f = getField(path)
  const id = fieldId(path)
  const attempts = attemptsFor(askedHistory, id)
  const escalation = escalationFor(attempts, askedHistory[id]?.confused || 0)
  return {
    type: 'field',
    id,
    fieldPath: path,
    section: f.section,
    sectionLabel: pick(SECTION_LABELS[f.section], locale),
    prompt: pick(f.label, locale),
    why: pick(f.purpose, locale),
    dataType: f.type,
    values: f.values || null,
    secureEntry: Boolean(f.secureEntry),
    voiceAllowed: Boolean(f.voiceAllowed) && !f.secureEntry,
    officialTextLocked: Boolean(f.officialTextLocked),
    allowUnknown: Boolean(f.allowUnknown),
    allowDecline: Boolean(f.allowDecline),
    allowSkip: !f.required && !optional ? true : Boolean(f.allowUnknown),
    optional,
    reason,
    escalation,
    attempts,
    locale,
    // Controls the borrower always has, at every question (§11).
    affordances: AFFORDANCES(locale, f),
  }
}

function structuralQuestion(s, { locale, askedHistory, state }) {
  const id = structuralId(s)
  const attempts = attemptsFor(askedHistory, id)
  const nextIndex = groupIndices(state, s.partyIndex, s.group).length
  const anchor = anchorFieldFor(s.group)
  const path = instantiate(`parties[].${s.group}[].${anchor}`, s.partyIndex, nextIndex)
  const f = getField(path)
  const copy = STRUCTURAL_COPY[s.kind]?.[s.group] || STRUCTURAL_COPY[s.kind]?.default
  return {
    type: 'field',
    id,
    structural: s.kind,
    fieldPath: path,
    section: s.group,
    sectionLabel: pick(SECTION_LABELS[s.group], locale),
    prompt: copy ? pick(copy.prompt, locale) : pick(f?.label, locale),
    why: copy ? pick(copy.why, locale) : pick(f?.purpose, locale),
    dataType: f?.type || 'text',
    values: f?.values || null,
    secureEntry: false,
    voiceAllowed: true,
    allowUnknown: true,
    allowDecline: false,
    allowSkip: false,
    escalation: escalationFor(attempts, askedHistory[id]?.confused || 0),
    attempts,
    locale,
    affordances: AFFORDANCES(locale, f || {}),
  }
}

function conflictQuestion(conflict, { locale, askedHistory }) {
  const f = getField(conflict.path)
  const id = conflictId(conflict.path)
  return {
    type: 'conflict',
    id,
    fieldPath: conflict.path,
    section: f?.section || null,
    sectionLabel: pick(SECTION_LABELS[f?.section], locale),
    prompt: pick(CONFLICT_COPY.prompt, locale).replace('{label}', (pick(f?.label, locale) || '').toLowerCase()),
    why: pick(CONFLICT_COPY.why, locale),
    choices: conflict.values.map((v) => ({ value: v, label: String(v) })),
    dataType: f?.type || 'text',
    escalation: escalationFor(attemptsFor(askedHistory, id)),
    attempts: attemptsFor(askedHistory, id),
    locale,
    affordances: AFFORDANCES(locale, f || {}),
  }
}

const anchorFieldFor = (group) => ({
  residence: 'street', employment: 'employerName', income: 'incomeType',
  assets: 'assetType', liabilities: 'liabilityType', reo: 'propertyAddress',
}[group] || 'street')

const STRUCTURAL_COPY = {
  min_records: {
    residence: {
      prompt: { en: 'What is the street address where you live now?', es: '¿Cuál es la dirección donde vive ahora?', ru: 'Какой у вас сейчас адрес проживания?' },
      why: { en: 'Lenders need a continuous two-year address history.', es: 'Se requiere un historial de dos años.', ru: 'Требуется история адресов за два года.' },
    },
    employment: {
      prompt: { en: 'Where do you work? Just the company name is fine.', es: '¿Dónde trabaja? Solo el nombre de la empresa.', ru: 'Где вы работаете? Достаточно названия компании.' },
      why: { en: 'Your employment supports the income used to qualify.', es: 'Su empleo respalda el ingreso.', ru: 'Занятость подтверждает доход.' },
    },
    income: {
      prompt: { en: 'What kind of income should we count — for example base pay from your job?', es: '¿Qué tipo de ingreso contamos, por ejemplo su salario base?', ru: 'Какой доход учитывать — например, базовую зарплату?' },
      why: { en: 'We need at least one income source to work with.', es: 'Necesitamos al menos una fuente de ingreso.', ru: 'Нужен хотя бы один источник дохода.' },
    },
    assets: {
      prompt: { en: 'What account holds the money for your down payment and closing costs?', es: '¿Qué cuenta tiene el dinero para el enganche?', ru: 'На каком счёте деньги для взноса и расходов?' },
      why: { en: 'Lenders verify where the funds to close come from.', es: 'Se verifica el origen de los fondos.', ru: 'Проверяется источник средств.' },
    },
    liabilities: {
      prompt: { en: 'What is the first debt we should list?', es: '¿Cuál es la primera deuda?', ru: 'Какой долг укажем первым?' },
      why: { en: 'Monthly obligations affect how much you can borrow.', es: 'Las obligaciones afectan cuánto puede pedir.', ru: 'Обязательства влияют на сумму кредита.' },
    },
    reo: {
      prompt: { en: 'What is the address of the other property you own?', es: '¿Cuál es la dirección de la otra propiedad?', ru: 'Какой адрес другой вашей недвижимости?' },
      why: { en: 'Every property you own is listed on the application.', es: 'Cada propiedad se lista en la solicitud.', ru: 'Вся ваша недвижимость указывается в заявке.' },
    },
  },
  history_backfill: {
    employment: {
      prompt: { en: 'Before that job, where did you work?', es: 'Antes de ese empleo, ¿dónde trabajaba?', ru: 'До этой работы где вы работали?' },
      why: { en: 'We need two continuous years of work history, so I need the job before this one.', es: 'Se requieren dos años continuos de historial laboral.', ru: 'Нужны два непрерывных года трудового стажа.' },
    },
    residence: {
      prompt: { en: 'Before that address, where did you live?', es: 'Antes de esa dirección, ¿dónde vivía?', ru: 'До этого адреса где вы жили?' },
      why: { en: 'We need two continuous years of address history.', es: 'Se requieren dos años continuos de historial.', ru: 'Нужны два непрерывных года истории адресов.' },
    },
    default: {
      prompt: { en: 'I need a bit more history to cover the required period.', es: 'Necesito más historial para cubrir el período.', ru: 'Нужно больше истории для покрытия периода.' },
      why: { en: 'The application requires a continuous two-year period.', es: 'La solicitud requiere dos años continuos.', ru: 'Требуется непрерывный двухлетний период.' },
    },
  },
  history_gap: {
    default: {
      prompt: { en: 'There is a gap in the dates. What were you doing during that time?', es: 'Hay un espacio en las fechas. ¿Qué hacía en ese tiempo?', ru: 'В датах есть промежуток. Чем вы занимались в это время?' },
      why: { en: 'Underwriting asks about any break longer than a month — a normal one is fine to explain.', es: 'Se pregunta por cualquier interrupción mayor a un mes.', ru: 'Андеррайтинг уточняет любой перерыв дольше месяца.' },
    },
  },
  history_overlap: {
    default: {
      prompt: { en: 'These dates overlap. Were you working both jobs at the same time?', es: 'Las fechas se superponen. ¿Trabajaba en ambos a la vez?', ru: 'Даты пересекаются. Вы работали на двух работах одновременно?' },
      why: { en: 'Two jobs at once is common — I just need to record it correctly.', es: 'Dos empleos a la vez es común.', ru: 'Две работы одновременно — обычное дело.' },
    },
  },
}

const PENDING_CONFIRM_COPY = {
  prompt: {
    en: 'Before we finish, please confirm what I saved.',
    es: 'Antes de terminar, confirme lo que guardé.',
    ru: 'Прежде чем закончить, подтвердите сохранённое.',
  },
  why: {
    en: 'These are the figures your application will be built on, so I want you to check them.',
    es: 'Su solicitud se basa en estas cifras, por eso le pido revisarlas.',
    ru: 'На этих данных строится заявка — пожалуйста, проверьте их.',
  },
}

const CONFLICT_COPY = {
  prompt: {
    en: 'I have two different answers recorded for {label}. Which one is right?',
    es: 'Tengo dos respuestas distintas para {label}. ¿Cuál es la correcta?',
    ru: 'У меня два разных ответа для «{label}». Какой верный?',
  },
  why: {
    en: 'I did not want to pick one for you — both came from something you told me.',
    es: 'No quise elegir por usted; ambas vienen de lo que me dijo.',
    ru: 'Я не стал выбирать за вас — оба варианта из ваших ответов.',
  },
}

// The controls §11 requires on EVERY question.
const AFFORDANCES = (locale, f) => {
  const t = (k) => (AFFORDANCE_COPY[k][locale] || AFFORDANCE_COPY[k].en)
  const list = [
    { id: 'why_asking', label: t('why_asking') },
    { id: 'do_not_understand', label: t('do_not_understand') },
    { id: 'show_saved', label: t('show_saved') },
    { id: 'correct_something', label: t('correct_something') },
    { id: 'talk_to_team', label: t('talk_to_team') },
  ]
  if (f.allowUnknown !== false) list.splice(2, 0, { id: 'do_not_know', label: t('do_not_know') })
  if (f.allowDecline) list.splice(2, 0, { id: 'decline_to_provide', label: t('decline_to_provide') })
  return list
}

const AFFORDANCE_COPY = {
  why_asking: { en: 'Why are you asking?', es: '¿Por qué lo pregunta?', ru: 'Почему вы спрашиваете?' },
  do_not_understand: { en: "I don't understand", es: 'No entiendo', ru: 'Я не понимаю' },
  do_not_know: { en: "I don't know yet", es: 'Todavía no sé', ru: 'Пока не знаю' },
  skip_for_now: { en: 'Skip for now', es: 'Omitir por ahora', ru: 'Пропустить пока' },
  show_saved: { en: 'Show me what you saved', es: 'Muéstreme lo guardado', ru: 'Показать сохранённое' },
  correct_something: { en: 'I need to correct something', es: 'Necesito corregir algo', ru: 'Нужно исправить' },
  talk_to_team: { en: 'Talk to my mortgage team', es: 'Hablar con mi equipo', ru: 'Связаться с командой' },
  decline_to_provide: { en: 'I do not wish to provide this', es: 'No deseo proporcionarlo', ru: 'Не желаю предоставлять' },
}

function pick(v, locale) {
  if (!v) return ''
  if (typeof v === 'string') return v
  return v[locale] || v.en || ''
}

/** Record that a question was asked — the caller persists the returned history. */
export function noteAsked(askedHistory, questionId, { at, confused = false } = {}) {
  const prev = askedHistory[questionId] || { attempts: 0, confused: 0, skipped: false }
  return {
    ...askedHistory,
    [questionId]: {
      ...prev,
      attempts: prev.attempts + 1,
      confused: prev.confused + (confused ? 1 : 0),
      lastAskedAt: at,
    },
  }
}

/** Temporarily skip a question the borrower asked to defer (§11 "Skip for now"). */
export function noteSkipped(askedHistory, questionId, { at } = {}) {
  const prev = askedHistory[questionId] || { attempts: 0, confused: 0 }
  return { ...askedHistory, [questionId]: { ...prev, skipped: true, skippedAt: at } }
}

/** Un-skip everything — used when the borrower reaches review so nothing stays hidden. */
export function clearSkips(askedHistory) {
  const out = {}
  for (const [k, v] of Object.entries(askedHistory)) out[k] = { ...v, skipped: false }
  return out
}

export const PLANNER_META = Object.freeze({
  sectionOrder: SECTION_ORDER,
  maxAttemptsBeforeEscalation: MAX_ATTEMPTS_BEFORE_ESCALATION,
  escalationLevels: ['normal', 'simplified', 'examples', 'assisted'],
  groups: Object.keys(GROUPS),
})
