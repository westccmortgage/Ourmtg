// Loan officer command center (spec §K.10, §F.7). Built on portal-review-queue: pipeline
// snapshot, a stuck-files panel, and a table of every active file with missing-doc /
// pending-review / open-condition counts and the single next action. Row → file detail.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { teamList, teamAdd, teamRemove, saveSettings } from '../lib/api'
import { fetchSettings } from '../lib/useSettings'
import { money, shortDate, relTime } from '../lib/format'
import { STAGE_LABEL, STAGE_STEPS } from '../lib/pipeline'
import { Alert, Empty } from '../components/ui'
import { flag } from '../domain/flags'
import { filesChangedSince, blockerSummary, filesNeedingBorrowerAction } from '../lib/loanTeamOps'

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
      <div className="workspace-page-head" id="overview">
        <div>
          <p className="workspace-kicker">Today’s operating view</p>
          <h1 className="mb0">Loan team dashboard</h1>
          <p className="muted mb0">One place to see what moved, what is blocked, and what needs a human decision.</p>
        </div>
        <Link to="/portal/new-file" className="btn btn-primary btn-sm">+ New loan file</Link>
      </div>

      <div className="card workspace-summary" id="review">
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

      {/* Phase 1B (flag-gated): deterministic blockers + what changed today. */}
      {flag('loanTeamWorkspaceV2') && (() => {
        const nowMs = Date.now()
        const blockers = blockerSummary(files)
        const changedToday = filesChangedSince(files, nowMs)
        const needAction = filesNeedingBorrowerAction(files)
        return (
          <div className="card">
            <div className="card-head"><h2>Blockers &amp; today</h2></div>
            <div className="metrics">
              <div className="metric"><span className="lbl">Files with blockers</span><span className="big-num">{blockers.blockingFiles}</span></div>
              <div className="metric"><span className="lbl">Missing docs</span><span className="big-num">{blockers.missingDocs}</span></div>
              <div className="metric"><span className="lbl">Open conditions</span><span className="big-num">{blockers.openConditions}</span></div>
              <div className="metric"><span className="lbl">Awaiting borrower</span><span className="big-num">{needAction.length}</span></div>
            </div>
            <div className="card-head" style={{ marginTop: 16 }}><h2 style={{ fontSize: 15 }}>What changed today</h2><span className="chip gray">{changedToday.length}</span></div>
            {changedToday.length === 0 && <Empty>No file activity in the last 24 hours.</Empty>}
            {changedToday.map((f) => (
              <div className="row" key={f.loanFileId} onClick={() => navigate(`/portal/file/${f.loanFileId}`)} style={{ cursor: 'pointer' }}>
                <div className="grow">
                  <div className="rlabel">{f.borrowerName || 'Unnamed borrower'}</div>
                  <div className="rsub">{f.nextAction} · {relTime(f.lastActivity)}</div>
                </div>
                <span className="btn btn-ghost btn-sm">Open →</span>
              </div>
            ))}
            <p className="hint" style={{ marginTop: 10 }}>Deterministic from stored file activity — no AI-generated summaries.</p>
          </div>
        )
      })()}

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

      <div className="card" id="pipeline">
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

      <div id="team"><TeamCard /></div>
      <div id="settings"><SiteSettingsCard /></div>
    </>
  )
}

// Site settings: the owner edits the live rate, loan programs, and home marketing
// copy here — the same values the public calculator, /plan builder, intake dropdowns
// and home hero read. Saved to site_settings via portal-settings-set (owner-gated).
function SiteSettingsCard() {
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSettings(true).then((s) => setForm({
      rate: String(s.rate),
      loanTypes: (s.loanTypes || []).join(', '),
      headline: s.home.headline,
      headlineAlt: s.home.headlineAlt,
      sub: s.home.sub,
    })).catch(() => setForm({ rate: '7', loanTypes: '', headline: '', headlineAlt: '', sub: '' }))
  }, [])

  if (!form) return null
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault()
    setBusy(true); setMsg(''); setError('')
    try {
      const r = await saveSettings({
        rate: Number(form.rate),
        loanTypes: form.loanTypes.split(',').map((s) => s.trim()).filter(Boolean),
        home: { headline: form.headline, headlineAlt: form.headlineAlt, sub: form.sub },
      })
      setMsg(`Saved. Live rate is now ${r.data.rate}%.`)
    } catch (err) {
      setError(err?.message || 'Could not save settings.')
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Site settings</h2><span className="chip gray">owner</span></div>
      <p className="muted mt0">Edits the public site — the calculator &amp; “Build my file” rate, the loan programs in dropdowns, and the home headline. Changes go live on the next visit; no deploy needed.</p>
      {msg && <Alert kind="ok">{msg}</Alert>}
      <Alert kind="error">{error}</Alert>
      <form onSubmit={save}>
        <div className="grid2">
          <div className="field">
            <label htmlFor="s-rate">Live rate % (calculator anchor)</label>
            <input id="s-rate" type="number" step="0.125" min="0" max="25" value={form.rate} onChange={set('rate')} />
          </div>
          <div className="field">
            <label htmlFor="s-types">Loan programs (comma-separated)</label>
            <input id="s-types" value={form.loanTypes} onChange={set('loanTypes')} placeholder="Conventional, FHA, VA…" />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="s-h1">Home headline (line 1)</label>
            <input id="s-h1" value={form.headline} onChange={set('headline')} maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="s-h2">Home headline (line 2)</label>
            <input id="s-h2" value={form.headlineAlt} onChange={set('headlineAlt')} maxLength={120} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="s-sub">Home subheadline</label>
          <textarea id="s-sub" value={form.sub} onChange={set('sub')} maxLength={600} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save site settings'}</button>
      </form>
    </div>
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
