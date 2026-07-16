// Phase 1B — "Money needed to close" PLANNING panel (§7D). Uses the deterministic engine
// (src/domain/cashToClose). Every figure is labeled by classification and never implies a
// lender quote or a final escrow number. When no figures are available yet, it shows the
// structure + an honest "your loan team will provide these" state — it does NOT fabricate
// numbers. Flag-gated by the caller (flags.cashToClosePlanner).
import { computeCashToClose } from '../domain/cashToClose'
import { money } from '../lib/format'

const CLASS_LABEL = {
  illustrative: 'Illustrative',
  estimated: 'Planning estimate',
  verified: 'Verified',
  final: 'Final (Closing Disclosure)',
}

export default function CashToClosePanel({ inputs = null }) {
  const hasData = inputs && Object.keys(inputs).length > 0
  const r = computeCashToClose(inputs || {})
  const rows = [
    ['Down payment', r.downPayment],
    ['Estimated closing costs', r.grossClosingCosts],
    ['Prepaid items & escrow', r.prepaidItems],
    ['Deposits & credits', r.depositsAndCredits ? -r.depositsAndCredits : 0],
  ]
  return (
    <div className="card">
      <div className="card-head">
        <h2>Money needed to close</h2>
        <span className="chip">{CLASS_LABEL[r.classification] || 'Planning estimate'}</span>
      </div>

      {!hasData && (
        <p className="muted">
          Your loan team will fill in these figures as your file progresses. Below is how we'll
          organize them — a planning view only, not a lender quote or a final escrow figure.
        </p>
      )}

      <div className="metrics" style={{ marginTop: 8 }}>
        {rows.map(([label, amt]) => (
          <div className="metric" key={label}>
            <span className="lbl">{label}</span>
            <span>{hasData ? money(amt) : '—'}</span>
          </div>
        ))}
      </div>

      <div className="callout" style={{ marginTop: 16 }}>
        <div className="k">Estimated cash to close</div>
        <p style={{ fontSize: 20, fontWeight: 700, margin: '4px 0 0' }}>
          {hasData ? money(r.estimatedCashToClose) : '—'}
          {hasData && r.range && r.range.low !== r.range.high && (
            <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}> ({money(r.range.low)}–{money(r.range.high)})</span>
          )}
        </p>
        {hasData && r.creditSurplus > 0 && (
          <p className="muted mb0" style={{ marginTop: 4 }}>Credits exceed costs — estimated surplus {money(r.creditSurplus)}.</p>
        )}
      </div>

      {hasData && (r.reservesRequirement > 0 || r.cashIdentified > 0) && (
        <div className="metrics" style={{ marginTop: 12 }}>
          {r.reservesRequirement > 0 && <div className="metric"><span className="lbl">Reserves required (kept, not brought)</span><span>{money(r.reservesRequirement)}</span></div>}
          {r.cashIdentified > 0 && <div className="metric"><span className="lbl">Cash you've identified</span><span>{money(r.cashIdentified)}</span></div>}
          {r.estimatedShortfall > 0 && <div className="metric"><span className="lbl">Estimated additional funds needed</span><span>{money(r.estimatedShortfall)}</span></div>}
          {r.estimatedSurplus > 0 && <div className="metric"><span className="lbl">Estimated surplus</span><span>{money(r.estimatedSurplus)}</span></div>}
        </div>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        Down payment, points, and post-closing reserves are shown separately. Estimates only —
        subject to change. This is not a loan offer, approval, or a final escrow figure.
      </p>
    </div>
  )
}
