// Conversational 1003 — the borrower's review view (§18).
//
// The secondary screen: everything captured, grouped into names a borrower recognizes, with a
// per-group state badge. Any item can be corrected conversationally by tapping it.

const GROUP_STATE_COPY = {
  complete: { en: 'Complete', es: 'Completo', ru: 'Готово' },
  in_progress: { en: 'Needs attention', es: 'Requiere atención', ru: 'Требует внимания' },
  needs_attention: { en: 'Needs attention', es: 'Requiere atención', ru: 'Требует внимания' },
  waiting_for_confirmation: { en: 'Waiting for your confirmation', es: 'Esperando su confirmación', ru: 'Ожидает подтверждения' },
  not_applicable: { en: 'Not applicable', es: 'No aplica', ru: 'Не применимо' },
}
const STATUS_COPY = {
  candidate: { en: 'not confirmed yet', es: 'sin confirmar', ru: 'не подтверждено' },
  conflicting: { en: 'two different answers', es: 'dos respuestas distintas', ru: 'два разных ответа' },
  needs_clarification: { en: 'needs a follow-up', es: 'requiere seguimiento', ru: 'нужно уточнение' },
  declined_allowed: { en: 'you chose not to provide this', es: 'eligió no proporcionarlo', ru: 'вы решили не указывать' },
  not_applicable: { en: 'does not apply', es: 'no aplica', ru: 'не применимо' },
}
const t = (dict, k, locale) => (dict[k] ? dict[k][locale] || dict[k].en : '')

const EMPTY = {
  en: 'Nothing here yet.', es: 'Nada aquí todavía.', ru: 'Пока ничего нет.',
}
const CORRECT = {
  en: 'Correct this', es: 'Corregir esto', ru: 'Исправить',
}

export default function ApplicationReview({ review, locale = 'en', onCorrect }) {
  if (!review?.groups) return null
  return (
    <div className="c1003-review-groups">
      {review.groups.map((g) => (
        <section key={g.section} className={`c1003-group c1003-group--${g.state}`}>
          <header>
            <h3>{g.label}</h3>
            <span className={`badge badge--${g.state}`}>{t(GROUP_STATE_COPY, g.state, locale)}</span>
          </header>

          {g.items.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>{EMPTY[locale] || EMPTY.en}</p>
          ) : (
            <ul className="c1003-items">
              {g.items.map((i) => (
                <li key={i.path} className={i.status === 'conflicting' ? 'conflict' : undefined}>
                  <span className="c1003-item-label">{i.label}</span>
                  <span className="c1003-item-value">
                    {/* A secure value is shown masked here, exactly as everywhere else. */}
                    {i.value ?? '—'}
                    {i.estimated && <em className="muted"> (estimate)</em>}
                  </span>
                  {STATUS_COPY[i.status] && (
                    <span className="muted c1003-item-status"> · {t(STATUS_COPY, i.status, locale)}</span>
                  )}
                  {i.conflictValues && (
                    <span className="muted"> ({i.conflictValues.join(' / ')})</span>
                  )}
                  {i.editable && !i.secure && (
                    <button type="button" className="linklike" onClick={() => onCorrect(i.path)}>
                      {CORRECT[locale] || CORRECT.en}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
