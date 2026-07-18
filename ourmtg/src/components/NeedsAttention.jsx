// Phase 1B/1C — "Needs Your Attention" borrower action list.
// - Phase 1C (task pilot): when real `tasks` are supplied, render them FIRST (plain-language,
//   localized EN/ES/RU). internal_requirement is never present (the API scrubs it).
// - Fallback: when no tasks (pilot off / none yet), derive items from the existing checklist +
//   conditions (src/lib/needsAttention) — current behavior preserved.
import { Link } from 'react-router-dom'
import { borrowerActionItems } from '../lib/needsAttention'
import { taskStatusLabel, taskActionLabel, blocksLabel, borrowerMustAct, reasonLabel } from '../lib/taskLabels'
import { useLang } from '../lib/i18n'
import { StatusChip } from './ui'

function TaskRow({ t, loanFileId, lang }) {
  const act = t.task_type === 'signature' ? 'view' : 'upload'
  const to = act === 'upload' ? `/portal/documents/${loanFileId}?task=${t.id}` : `/portal/documents/${loanFileId}`
  return (
    <div className="row">
      <div className="grow">
        <div className="rlabel">
          {t.title}
          {t.is_blocking && <span className="chip" style={{ marginLeft: 8 }}>{blocksLabel(lang)}</span>}
        </div>
        {t.borrower_explanation && <div className="rsub">{t.borrower_explanation}</div>}
        {t.borrower_visible_status_reason && (
          <div className="rsub" style={{ color: 'var(--danger, #b91c1c)' }}>
            {reasonLabel(lang)}: {t.borrower_visible_status_reason}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="chip gray">{taskStatusLabel(t.status, lang)}</span>
        {borrowerMustAct(t.status) && (
          <Link className="btn btn-primary btn-sm" to={to} style={{ minHeight: 44 }}>
            {taskActionLabel(act, lang)} →
          </Link>
        )}
      </div>
    </div>
  )
}

export default function NeedsAttention({ loanFileId, checklistItems = [], conditions = [], tasks = null }) {
  const { lang } = useLang()
  // Pilot path: real tasks the borrower must act on.
  const actionTasks = Array.isArray(tasks) ? tasks.filter((t) => borrowerMustAct(t.status)) : null

  if (actionTasks && actionTasks.length > 0) {
    return (
      <div className="card">
        <div className="card-head"><h2>Needs your attention</h2><span className="chip amber">{actionTasks.length}</span></div>
        {actionTasks.map((t) => <TaskRow key={t.id} t={t} loanFileId={loanFileId} lang={lang} />)}
      </div>
    )
  }

  // Fallback: derive from checklist + conditions.
  const items = borrowerActionItems({ checklistItems, conditions })
  if (items.length === 0) {
    return (
      <div className="card">
        <div className="card-head"><h2>Needs your attention</h2></div>
        <p className="muted mb0">You're all caught up — nothing needs your action right now. 🎉</p>
      </div>
    )
  }
  return (
    <div className="card">
      <div className="card-head"><h2>Needs your attention</h2><span className="chip amber">{items.length}</span></div>
      {items.map((it) => (
        <div className="row" key={it.key}>
          <div className="grow">
            <div className="rlabel">
              {it.title}
              {it.blocking && <span className="chip" style={{ marginLeft: 8 }}>{blocksLabel(lang)}</span>}
            </div>
            <div className="rsub">{it.why}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusChip status={it.status} />
            <Link className="btn btn-primary btn-sm" to={`/portal/documents/${loanFileId}`} style={{ minHeight: 44 }}>
              {it.action.label} →
            </Link>
          </div>
        </div>
      ))}
    </div>
  )
}
