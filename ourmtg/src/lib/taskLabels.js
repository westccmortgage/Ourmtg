// Phase 1C — plain-language, trilingual (EN/ES/RU) labels for borrower-visible task states and
// actions. Internal-only statuses (prechecked/team_review) map to a borrower-safe "under review".
// Pure; unit-testable.

const STATUS = {
  created:  { en: 'New', es: 'Nuevo', ru: 'Новая' },
  assigned: { en: 'Ready for you', es: 'Listo para ti', ru: 'Готово к действию' },
  viewed:   { en: 'Opened', es: 'Abierto', ru: 'Открыто' },
  in_progress: { en: 'In progress', es: 'En curso', ru: 'В процессе' },
  submitted: { en: 'Under review', es: 'En revisión', ru: 'На проверке' },
  prechecked: { en: 'Under review', es: 'En revisión', ru: 'На проверке' },
  team_review: { en: 'Under review', es: 'En revisión', ru: 'На проверке' },
  accepted: { en: 'Accepted', es: 'Aceptado', ru: 'Принято' },
  rejected: { en: 'Needs another', es: 'Se necesita otro', ru: 'Нужно заново' },
  more_information_needed: { en: 'More info needed', es: 'Se necesita más información', ru: 'Нужны уточнения' },
  completed: { en: 'Completed', es: 'Completado', ru: 'Завершено' },
  reopened: { en: 'Reopened', es: 'Reabierto', ru: 'Возобновлено' },
  cancelled: { en: 'Cancelled', es: 'Cancelado', ru: 'Отменено' },
}

const ACTION = {
  upload: { en: 'Upload', es: 'Subir', ru: 'Загрузить' },
  open:   { en: 'Open', es: 'Abrir', ru: 'Открыть' },
  start:  { en: 'Start', es: 'Comenzar', ru: 'Начать' },
  view:   { en: 'View', es: 'Ver', ru: 'Просмотр' },
}

const BLOCKS = { en: 'Blocks your loan', es: 'Bloquea tu préstamo', ru: 'Блокирует ваш кредит' }

const pick = (map, key, lang) => (map[key] && (map[key][lang] || map[key].en)) || key

export function taskStatusLabel(status, lang = 'en') { return pick(STATUS, status, lang) }
export function taskActionLabel(action, lang = 'en') { return pick(ACTION, action, lang) }
export function blocksLabel(lang = 'en') { return BLOCKS[lang] || BLOCKS.en }

// True for statuses where the borrower is expected to act (vs. under review / done).
export function borrowerMustAct(status) {
  return ['created', 'assigned', 'viewed', 'in_progress', 'rejected', 'more_information_needed', 'reopened'].includes(status)
}
