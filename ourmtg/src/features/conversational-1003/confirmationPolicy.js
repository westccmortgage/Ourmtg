// Conversational 1003 — confirmation policy (§14).
//
// Confirming after every sentence makes the conversation unusable; confirming nothing makes
// the application untrustworthy. The rule: captured values are shown immediately as editable
// chips, and only HIGH-IMPACT values interrupt with an explicit "is that right?".

import { getField, chipLabel } from './applicationCatalog.js'

// Sections whose values always require an explicit confirmation, regardless of the field's own
// flag — identity, money, ownership, and anything with legal weight.
const ALWAYS_CONFIRM_SECTIONS = new Set(['declarations'])

/** Does this single field need an explicit confirmation step before it can resolve? */
export function requiresConfirmation(path) {
  const f = getField(path)
  if (!f) return false
  if (f.secureEntry) return true
  if (ALWAYS_CONFIRM_SECTIONS.has(f.section)) return true
  return Boolean(f.confirmRequired || f.highImpact)
}

/**
 * Group this turn's candidates into ONE confirmation card, so the borrower answers
 * "Correct / Change it / I'm not sure" once rather than per field.
 * Returns null when nothing in the batch warrants interrupting.
 */
export function buildConfirmation(candidates, { locale = 'en' } = {}) {
  const needing = (candidates || []).filter((c) => requiresConfirmation(c.path))
  if (!needing.length) return null
  return {
    kind: 'confirmation',
    locale,
    prompt: CONFIRM_PROMPT[locale] || CONFIRM_PROMPT.en,
    items: needing.map((c) => ({
      path: c.path,
      // The short noun label ("income amount"), not the question ("How much is it?") —
      // a confirmation card reads as a list of facts, not a re-run of the interview.
      label: chipLabel(c.path, locale),
      displayValue: c.displayValue ?? String(c.value ?? ''),
      estimated: Boolean(c.estimated),
    })),
    options: CONFIRM_OPTIONS[locale] || CONFIRM_OPTIONS.en,
  }
}

const CONFIRM_PROMPT = {
  en: 'I understood:',
  es: 'Entendí:',
  ru: 'Я записал:',
}

// Exactly the three options §14 requires — "I'm not sure" must never be missing, because a
// borrower who is unsure needs a path that is not "Correct".
const CONFIRM_OPTIONS = {
  en: [
    { id: 'correct', label: 'Correct' },
    { id: 'change', label: 'Change it' },
    { id: 'unsure', label: "I'm not sure" },
  ],
  es: [
    { id: 'correct', label: 'Correcto' },
    { id: 'change', label: 'Cambiarlo' },
    { id: 'unsure', label: 'No estoy seguro' },
  ],
  ru: [
    { id: 'correct', label: 'Верно' },
    { id: 'change', label: 'Изменить' },
    { id: 'unsure', label: 'Не уверен' },
  ],
}

/** Candidates that may resolve silently (shown as a chip, no interruption). */
export function silentlyAcceptable(candidates) {
  return (candidates || []).filter((c) => !requiresConfirmation(c.path))
}

export const CONFIRMATION_META = Object.freeze({
  alwaysConfirmSections: [...ALWAYS_CONFIRM_SECTIONS],
  optionIds: ['correct', 'change', 'unsure'],
})
