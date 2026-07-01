// Loan officer command center (spec §K.10, §F.7). Built on portal-review-queue: pipeline
// snapshot, a stuck-files panel, and a table of every active file with missing-doc /
// pending-review / open-condition counts and the single next action. Row → file detail.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { teamList, teamAdd, teamRemove } from '../lib/api'
import { money, shortDate, relTime } from '../lib/format'
import { STAGE_LABEL, STAGE_STEPS } from '../lib/pipeline'
import { Alert, Empty } from '../components/ui'

export default function LODashboard({ files }) {
  const navigate = useNavigate()

  const summary = useMemo(() => {
    const byStage = {}
    let stuck = 0, pendingReview = 0
    for (const f of files) {
      byStage[f.stage] = (byStage[f.stage] || 0) + 1
      if (f.stuck) stuck++
      pendingReview += f.pendingReview || 0
    }
    return { byStage, stuck, pendingReview, total: files.length }
  }, [files])

  const stuckFiles = files.filter((f) => f.stuck)

  return (
    <>
      <div className="spread">
        <h1 className="mb0">Loan team dashboard</h1>
        <Link to="/portal/new-file" className="btn btn-primary btn-sm">+ New loan file</Link>
      </div>

      <div className="card">
        <div className="metrics">
          <div className="metric"><span className="lbl">Active files</span><span className="big-num">{summary.total}</span></div>
          <div className="metric"><span className="lbl">Docs to review</span><span className="big-num">{summary.pendingReview}</span></div>
          <div className="metric"><span className="lbl">Stuck files</span><span className="big-num" style={{ color: summary.stuck ? 'var(--red)' : undefined }}>{summary.stuck}</span></div>
        </div>
        <div className="pill-row" style={{ marginTop: 16 }}>
          {STAGE_STEPS.filter((s) => summary.byStage[s]).map((s) => (
            <span key={s} className="chip gray">{STAGE_LABEL[s]}: {summary.byStage[s]}</span>
          ))}
        </div>
      </div>

      {stuckFiles.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>⚠️ Stuck files</h2><span className="chip red">{stuckFiles.length}</span></div>
          {stuckFiles.map((f) => (
            <div className="row" key={f.loanFileId} onClick={() => navigate(`/portal/file/${f.loanFileId}`)} style={{ cursor: 'pointer' }}>
              <div className="grow">
                <div className="rlabel">{f.borrowerName || 'Unnamed borrower'}</div>
                <div className="rsub">{f.nextAction} · {relTime(f.lastActivity)}</div>
              </div>
              <span className="btn btn-ghost btn-sm">Open →</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>All active files</h2></div>
        {files.length === 0 && <Empty>No active loan files yet. Files appear here as GRCRM deals sync in.</Empty>}
        {files.length > 0 && (
          <div className="tablewrap">
            <table className="q">
              <thead>
                <tr>
                  <th>Borrower</th><th>Stage</th><th>Missing</th><th>To review</th>
                  <th>Conditions</th><th>Next action</th><th>Close</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.loanFileId} onClick={() => navigate(`/portal/file/${f.loanFileId}`)}>
                    <td>
                      <strong>{f.borrowerName || '—'}</strong>
                      {f.stuck && <span className="chip red" style={{ marginLeft: 6 }}>stuck</span>}
                      {f.loanNumber && <div className="muted" style={{ fontSize: 12 }}>#{f.loanNumber}</div>}
                    </td>
                    <td>{f.stageLabel}</td>
                    <td>{f.missingDocs || '—'}</td>
                    <td>{f.pendingReview ? <span className="chip amber">{f.pendingReview}</span> : '—'}</td>
                    <td>{f.openConditions || '—'}</td>
                    <td style={{ minWidth: 180 }}>{f.nextAction}</td>
                    <td>{f.estCloseDate ? shortDate(f.estCloseDate) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 12 }}>Amounts and pre-approval are managed inside each file. Tap a row to review documents, set pre-approval, or invite the borrower/realtor.</p>
      </div>

      <TeamCard />
    </>
  )
}

// My team: processors/assistants who get internal access to every file I own.
// Add requires the person to have signed in once (magic link) so their account exists.
function TeamCard() {
  const [members, setMembers] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('processor')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => teamList().then((r) => setMembers(r.members || [])).catch(() => setMembers([]))
  useEffect(() => { load() }, [])

  async function add(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await teamAdd(email.trim(), role)
      setEmail('')
      await load()
    } catch (err) { setError(err?.message || 'Could not add team member.') }
    finally { setBusy(false) }
  }

  async function remove(memberUserId) {
    setBusy(true)
    try { await teamRemove(memberUserId); await load() } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>My team</h2></div>
      <p className="muted mt0">Processors and assistants see and work every file you own — review queue, documents, conditions, invites.</p>
      {members === null && <Empty>Loading…</Empty>}
      {members && members.length === 0 && <Empty>No team members yet.</Empty>}
      {members && members.map((m) => (
        <div className="row" key={m.memberUserId}>
          <div className="grow">
            <div className="rlabel">{m.email || m.memberUserId}</div>
            <div className="rsub">{m.role}</div>
          </div>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => remove(m.memberUserId)}>Remove</button>
        </div>
      ))}
      <form onSubmit={add} style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <Alert kind="error">{error}</Alert>
        <div className="grid2">
          <div className="field">
            <label htmlFor="tm-email">Email</label>
            <input id="tm-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" />
          </div>
          <div className="field">
            <label htmlFor="tm-role">Role</label>
            <select id="tm-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="processor">Processor</option>
              <option value="assistant">Assistant</option>
            </select>
          </div>
        </div>
        <button className="btn btn-navy btn-sm" disabled={busy || !email}>{busy ? 'Adding…' : 'Add team member'}</button>
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>They must sign in once at this site first (magic link) so their account exists.</p>
      </form>
    </div>
  )
}
