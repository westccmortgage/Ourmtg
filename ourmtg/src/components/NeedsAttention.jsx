// Phase 1B — "Needs Your Attention" borrower action list (§7A). Derived deterministically from
// the existing checklist + conditions (src/lib/needsAttention). Flag-gated by the caller.
import { Link } from 'react-router-dom'
import { borrowerActionItems } from '../lib/needsAttention'
import { StatusChip } from './ui'

export default function NeedsAttention({ loanFileId, checklistItems = [], conditions = [] }) {
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
      <div className="card-head">
        <h2>Needs your attention</h2>
        <span className="chip amber">{items.length}</span>
      </div>
      {items.map((it) => (
        <div className="row" key={it.key}>
          <div className="grow">
            <div className="rlabel">
              {it.title}
              {it.blocking && <span className="chip" style={{ marginLeft: 8 }}>Blocks your loan</span>}
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
