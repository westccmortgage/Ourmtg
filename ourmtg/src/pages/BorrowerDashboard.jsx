// Borrower dashboard (spec §K.3): status bar + "what's next", a documents summary card,
// and a conditions card. Status/checklist come from the gateway (column-scoped); the
// conditions list is a direct RLS read (borrower/co-borrower only). Supports multiple
// files via a compact selector, though most borrowers have exactly one.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getStatus, getChecklist, listConditions, listMessages } from '../lib/api'
import { BRAND } from '../lib/config'
import { money, shortDate } from '../lib/format'
import StatusTracker from '../components/StatusTracker'
import MessageThread from '../components/MessageThread'
import { Alert, Spinner, StatusChip, Empty } from '../components/ui'

export default function BorrowerDashboard({ grants }) {
  const [active, setActive] = useState(grants[0]?.loan_file_id || null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!active) return
    let alive = true
    setLoading(true); setError('')
    Promise.all([
      getStatus(active),
      getChecklist(active).catch(() => null),
      listConditions(active).catch(() => []),
      listMessages(active).catch(() => []),
    ])
      .then(([status, checklist, conditions, messages]) => {
        if (alive) setData({ status, checklist, conditions, messages })
      })
      .catch((err) => { if (alive) setError(err?.message || 'Could not load your loan.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [active])

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return null

  const { status, checklist, conditions, messages } = data
  const openConditions = (conditions || []).filter((c) => c.status !== 'cleared')
  const reloadMessages = () =>
    listMessages(active).then((m) => setData((d) => ({ ...d, messages: m }))).catch(() => {})

  return (
    <>
      <div className="spread" style={{ marginBottom: 8 }}>
        <h1 className="mb0">Hi{status.borrowerName ? `, ${status.borrowerName.split(' ')[0]}` : ''} 👋</h1>
        {grants.length > 1 && (
          <select value={active} onChange={(e) => setActive(e.target.value)} style={{ width: 'auto' }}>
            {grants.map((g) => <option key={g.loan_file_id} value={g.loan_file_id}>File {g.loan_file_id.slice(0, 8)}</option>)}
          </select>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Your loan status</h2>
          <span className="chip">{status.stageLabel}</span>
        </div>
        <StatusTracker steps={status.steps} stage={status.stage} />
        <div className="callout" style={{ marginTop: 16 }}>
          <div className="k">What’s next</div>
          <p>{status.whatsNext}</p>
        </div>
        <div className="metrics" style={{ marginTop: 16 }}>
          {status.loanType && <div className="metric"><span className="lbl">Loan type</span><span>{status.loanType}</span></div>}
          {status.purpose && <div className="metric"><span className="lbl">Purpose</span><span>{status.purpose}</span></div>}
          {status.amount != null && <div className="metric"><span className="lbl">Loan amount</span><span>{money(status.amount)}</span></div>}
          {status.estCloseDate && <div className="metric"><span className="lbl">Est. closing</span><span>{shortDate(status.estCloseDate)}</span></div>}
        </div>
      </div>

      <Link to={`/portal/documents/${active}`} className="card linkcard">
        <div className="spread">
          <div>
            <h2 className="mb0">Documents</h2>
            <p className="mb0 muted">
              {checklist ? `${checklist.uploaded} of ${checklist.total} uploaded${checklist.remaining ? ` · ${checklist.remaining} to go` : ' · all in!'}` : 'View your checklist'}
            </p>
          </div>
          <span className="btn btn-primary btn-sm">Upload →</span>
        </div>
      </Link>

      <div className="card">
        <div className="card-head"><h2>Conditions</h2>{openConditions.length > 0 && <span className="chip amber">{openConditions.length} to clear</span>}</div>
        {(!conditions || conditions.length === 0) && <Empty>No underwriting conditions yet. We’ll post any here as they come up.</Empty>}
        {conditions && conditions.map((c) => (
          <div className="row" key={c.id}>
            <div className="grow">
              <div className="rlabel">{c.title}</div>
              {c.detail && <div className="rsub">{c.detail}</div>}
            </div>
            <StatusChip status={c.status} />
          </div>
        ))}
        {openConditions.length > 0 && (
          <p className="hint" style={{ marginTop: 12 }}>To satisfy a condition, upload the requested item on your Documents page or message your loan team below.</p>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Messages</h2></div>
        <MessageThread loanFileId={active} messages={messages} onSent={reloadMessages}
          placeholder="Ask your loan team anything…" />
      </div>

      <div className="card">
        <div className="card-head"><h2>Your team</h2></div>
        <div className="row">
          <div className="grow">
            <div className="rlabel">{BRAND.company}</div>
            <div className="rsub">
              Office <a href={`tel:${BRAND.officePhone}`}>{BRAND.officePhone}</a>
              {BRAND.loPhone && <> · {BRAND.loName || 'Direct'} <a href={`tel:${BRAND.loPhone}`}>{BRAND.loPhone}</a></>}
            </div>
          </div>
          <a className="btn btn-ghost btn-sm" href={`tel:${BRAND.loPhone || BRAND.officePhone}`}>Call</a>
        </div>
      </div>
    </>
  )
}
