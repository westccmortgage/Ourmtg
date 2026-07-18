// Borrower dashboard (spec §K.3): status bar + "what's next", a documents summary card,
// and a conditions card. Status/checklist come from the gateway (column-scoped); the
// conditions list is a direct RLS read (borrower/co-borrower only). Supports multiple
// files via a compact selector, though most borrowers have exactly one.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getStatus, getChecklist, listConditions, listMessages, listTasks } from '../lib/api'
import { STAGE_COLOR } from '../lib/pipeline'
import { money, shortDate } from '../lib/format'
import StatusTracker from '../components/StatusTracker'
import MessageThread from '../components/MessageThread'
import { Alert, Spinner, StatusChip, Empty } from '../components/ui'
import { flag } from '../domain/flags'
import NeedsAttention from '../components/NeedsAttention'
import CashToClosePanel from '../components/CashToClosePanel'
import ThirdPartyPanel from '../components/ThirdPartyPanel'
import TeamContactCard from '../components/TeamContactCard'
import { BorrowerStatementIncome } from '../components/StatementIncomePanel'

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
      // Task pilot (flag): fetch real borrower tasks; safe fallback to null when off/unavailable.
      flag('taskPilot') ? listTasks(active).then((r) => r?.tasks || []).catch(() => null) : Promise.resolve(null),
    ])
      .then(([status, checklist, conditions, messages, tasks]) => {
        if (alive) setData({ status, checklist, conditions, messages, tasks })
      })
      .catch((err) => { if (alive) setError(err?.message || 'Could not load your loan.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [active])

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return null

  const { status, checklist, conditions, messages, tasks } = data
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

      {/* Phase 1B/1C (flag-gated): borrower "Needs your attention" at the very top. When the
          task pilot is on, it renders real tasks; otherwise it derives from checklist+conditions. */}
      {(flag('borrowerWorkspaceV2') || flag('taskPilot')) && (
        <NeedsAttention loanFileId={active} checklistItems={checklist?.items || []} conditions={conditions || []} tasks={tasks} />
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <span className="stagenum" style={{ '--stage': STAGE_COLOR[status.stage] }} aria-hidden="true">
          {(status.step ?? 0) + 1}
        </span>
        <p className="fileno">File № {String(active).slice(0, 8).toUpperCase()}</p>
        <div className="card-head" style={{ paddingRight: 70 }}>
          <h2>Your loan status</h2>
          <span className="stamp ink" style={{ '--stage': STAGE_COLOR[status.stage] }}>{status.stageLabel}</span>
        </div>
        <StatusTracker steps={status.steps} stage={status.stage} />
        <div className="callout" style={{ marginTop: 18 }}>
          <div className="k">What’s next</div>
          <p>{status.whatsNext}</p>
        </div>
        <div className="metrics" style={{ marginTop: 18 }}>
          {status.loanType && <div className="metric"><span className="lbl">Loan type</span><span>{status.loanType}</span></div>}
          {status.purpose && <div className="metric"><span className="lbl">Purpose</span><span>{status.purpose}</span></div>}
          {status.amount != null && <div className="metric"><span className="lbl">Loan amount</span><span>{money(status.amount)}</span></div>}
          {status.estCloseDate && <div className="metric"><span className="lbl">Est. closing</span><span>{shortDate(status.estCloseDate)}</span></div>}
        </div>
      </div>

      {messages && messages.length > 0 && (
        <div className="ticker" style={{ margin: '0 0 16px' }} aria-hidden="true">
          <span className="in">
            {[0, 1].map((rep) => (
              <span key={rep}>
                {messages.slice(0, 6).map((m) => (
                  <span key={`${rep}-${m.id}`}>&nbsp;<b>{shortDate(m.created_at)}</b> {m.body} ·</span>
                ))}
              </span>
            ))}
          </span>
        </div>
      )}

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

      <BorrowerStatementIncome loanFileId={active} />

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

      {/* Phase 1B (flag-gated): money-needed-to-close planning view + third-party progress. */}
      {flag('cashToClosePlanner') && <CashToClosePanel inputs={null} />}
      {flag('thirdPartyTracking') && <ThirdPartyPanel statuses={{}} />}

      <div className="card">
        <div className="card-head"><h2>Messages</h2></div>
        <MessageThread loanFileId={active} messages={messages} onSent={reloadMessages}
          placeholder="Ask your loan team anything…" />
      </div>

      {/* Verified mortgage-team contact + licensing (always shown). */}
      <TeamContactCard />
    </>
  )
}
