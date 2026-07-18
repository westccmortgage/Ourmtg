// Phase 1B — third-party progress placeholders (§7E): appraisal / title / escrow / insurance.
// Shows STATUS placeholders only. It does NOT fabricate integration data — with no data yet,
// every item reads "Not started / we'll update you." Flag-gated (flags.thirdPartyTracking).
import { StatusChip } from './ui'

const ITEMS = [
  { key: 'appraisal', label: 'Appraisal', note: 'Confirms the home’s value.' },
  { key: 'title', label: 'Title', note: 'Confirms clear ownership.' },
  { key: 'escrow', label: 'Escrow / settlement', note: 'Holds funds and coordinates signing.' },
  { key: 'insurance', label: 'Homeowners insurance', note: 'Required before closing.' },
]

// statuses: optional map { appraisal: 'ordered', ... }. Absent → 'not_started' (no fabrication).
const LABEL = {
  not_started: 'Not started', ordered: 'Ordered', scheduled: 'Scheduled', in_progress: 'In progress',
  received: 'Received', completed: 'Completed', delayed: 'Delayed', cancelled: 'Cancelled',
}

export default function ThirdPartyPanel({ statuses = {} }) {
  return (
    <div className="card">
      <div className="card-head"><h2>Appraisal, title & escrow</h2></div>
      {ITEMS.map((it) => {
        const s = statuses[it.key] || 'not_started'
        return (
          <div className="row" key={it.key}>
            <div className="grow">
              <div className="rlabel">{it.label}</div>
              <div className="rsub">{it.note}</div>
            </div>
            <span className={`chip ${s === 'delayed' ? 'amber' : ''}`}>{LABEL[s] || 'Not started'}</span>
          </div>
        )
      })}
      <p className="hint" style={{ marginTop: 10 }}>
        We’ll update each item here as it’s ordered and completed — no need to call to check.
      </p>
    </div>
  )
}
