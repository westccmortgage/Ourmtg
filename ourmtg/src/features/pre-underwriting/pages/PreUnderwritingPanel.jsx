// Autopilot Pre-Underwriting — Level 4, the working panel.
//
// This is the screen the whole architecture exists to serve. A processor opens it and sees, in
// this order, what they would otherwise spend a morning assembling:
//
//     how ready the file is, and what that number does not mean
//     what is missing, split by who can actually send it
//     what the rules think is worth a look, each one openable down to the evidence
//     which programs are worth pursuing, with what was and was not checked
//
// Everything on it is computed server-side by the pure layers. This component fetches and lays
// out; it decides nothing, which is why the numbers here and the numbers in the tests cannot
// drift apart.
//
// THE ONE THING IT WILL NEVER GROW: an approve button. There is no action here that resolves a
// loan, only actions that resolve a QUESTION about a loan.

import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Alert } from '../../../components/ui'
import { getPanel, resolveFinding, reanalyse, readDocument } from '../api'

const SEVERITY_CHIP = { high: 'chip red', medium: 'chip amber', low: 'chip gray' }
const CATEGORY_LABEL = {
  income: 'Income', employment: 'Employment', assets: 'Assets', liabilities: 'Liabilities',
  identity: 'Identity', property: 'Property', documents: 'Documents',
}

export default function PreUnderwritingPanel() {
  const { loanFileId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { setData(await getPanel(loanFileId)); setError('') } catch (e) { setError(e.message) }
  }, [loanFileId])
  useEffect(() => { load() }, [load])

  async function act(fn, key) {
    setBusy(key); setError('')
    try { const res = await fn(); if (res?.readiness) setData(res); else await load() } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  if (error && !data) return <Alert kind="error">{error}</Alert>
  if (!data) return <p className="muted">Reading the file…</p>

  const { readiness, missing, findings, programs, credit, unread, facts } = data
  const open = findings.filter((f) => f.status === 'pending_review')
  const decided = findings.filter((f) => f.status !== 'pending_review')

  return (
    <div style={{ maxWidth: 820, margin: '0 auto' }}>
      <Link to={`/portal/file/${loanFileId}`} className="backlink">← Back to loan file</Link>
      <h1 style={{ marginBottom: 4 }}>Pre-underwriting</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Prepared automatically from the documents on this file. Every conclusion below is a
        question for you, not an answer.
      </p>

      {error && <Alert kind="error">{error}</Alert>}

      {/* ── Readiness ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <h2>Loan readiness</h2>
          <span className="chip gray">{readiness.percent}%</span>
        </div>
        <div className="c1003-bar" role="progressbar" aria-valuenow={readiness.percent} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${readiness.percent}%` }} />
        </div>
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 4 }}>{readiness.meaning}</p>
        {/* Travels with the number, always. A percentage next to somebody's name gets read as a
            probability of approval by someone, eventually, however it is labelled. */}
        <p className="hint" style={{ marginTop: 0 }}>
          It is <b>not</b> {readiness.notMeaning.join(', ')}. A file at 100% can still be denied;
          a file at 40% can close.
        </p>
        <div className="metrics" style={{ marginTop: 12 }}>
          <Metric label="Documents" v={readiness.components.documents} extra={`${readiness.components.documents.complete}/${readiness.components.documents.total}`} />
          <Metric label="Open questions" v={readiness.components.questions} extra={`${readiness.components.questions.open} open`} />
          <Metric label="Read quality" v={readiness.components.confidence} extra={`${readiness.components.confidence.readings} values`} />
        </div>
      </div>

      {/* ── The numbers ───────────────────────────────────────────────────── */}
      {facts && (
        <div className="card">
          <div className="card-head">
            <h2>The numbers</h2>
            {!facts.ready && <span className="chip amber">{facts.missing.length} not yet computable</span>}
          </div>
          {/* Each one shows what it came from. A processor who cannot see where a DTI came from
              has to recompute it by hand, which is the work this was supposed to remove. */}
          <Fact label="Credit score" value={facts.creditScore.score} basis={facts.creditScore.basis} />
          <Fact label="Qualifying income" value={facts.income.monthly} money basis={facts.income.basis}
            warn={facts.income.monthly !== null && !facts.income.documented} />
          <Fact label="Monthly obligations" value={facts.debt.monthly} money basis={facts.debt.basis}
            warn={facts.debt.unknownPayments > 0} />
          <Fact label="DTI" value={facts.dti.percent} pct
            basis={facts.dti.kind || (facts.dti.missing.length ? `needs ${facts.dti.missing.join(', ')}` : '')} />
          <Fact label="LTV" value={facts.ltv.percent} pct
            basis={facts.ltv.basis || (facts.ltv.missing.length ? `needs ${facts.ltv.missing.join(', ')}` : '')} />
        </div>
      )}

      {/* ── Credit permission ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <h2>Credit</h2>
          <span className={credit.authorized ? 'chip green' : 'chip red'}>
            {credit.authorized ? 'Authorized' : 'Not authorized'}
          </span>
        </div>
        {credit.authorized ? (
          <p className="mb0 muted">
            Permission is on file{credit.expiresAt ? ` until ${new Date(credit.expiresAt).toLocaleDateString()}` : ''}. You may order the report.
          </p>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>{credit.gap?.explanation}</p>
            {/* Deliberately not a button that authorizes. Only the borrower can do that, and a
                control here that looked like it might is the beginning of someone clicking it. */}
            <p className="hint mb0">
              Only the borrower can give this. Send them their application link — the authorization
              is one tap on their side, and the wording they will read is fixed and recorded.
            </p>
          </>
        )}
      </div>

      {/* ── Missing ───────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head"><h2>Missing</h2></div>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>The borrower needs to send</h3>
        {missing.borrower.length === 0 && <p className="muted">Nothing — everything they can send is here.</p>}
        {missing.borrower.map((m) => (
          <div key={m.docKey} className="row" style={{ display: 'block', marginBottom: 8 }}>
            <div className="rlabel">{m.label}</div>
            {m.asks.map((a) => <p key={a} className="mb0 muted" style={{ fontSize: 13 }}>{a}</p>)}
          </div>
        ))}

        <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>You need to obtain</h3>
        {missing.loanTeam.length === 0 && <p className="muted mb0">Nothing outstanding on your side.</p>}
        {missing.loanTeam.map((m) => (
          <div key={m.docKey} className="row" style={{ display: 'block', marginBottom: 8 }}>
            <div className="rlabel">{m.label}</div>
            {m.detail && <p className="mb0 muted" style={{ fontSize: 13 }}>{m.detail}</p>}
          </div>
        ))}
      </div>

      {/* ── Not yet read ──────────────────────────────────────────────────── */}
      {unread.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Uploaded but not read</h2>
            <span className="chip amber">{unread.length}</span>
          </div>
          {/* Named rather than silently skipped: a panel that omitted these would be claiming a
              completeness it has not actually checked. */}
          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
            These are on the file but nothing has read them yet, so nothing above accounts for them.
          </p>
          {unread.map((u) => (
            <div key={u.id} className="row">
              <div className="spread">
                <div className="rlabel">{u.label || u.docKey}</div>
                <button type="button" className="btn btn-sm" disabled={busy === u.id}
                  onClick={() => act(() => readDocument(loanFileId, u.id), u.id)}>
                  {busy === u.id ? 'Reading…' : 'Read it'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Findings ──────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <h2>Worth a look</h2>
          <span className="chip gray">{open.length}</span>
        </div>
        {open.length === 0 && <p className="muted">Nothing outstanding. That is not a clearance — it means no rule fired on what is here.</p>}
        {open.map((f) => (
          <Finding key={f.id} f={f} busy={busy}
            onResolve={(action, note, correctedFields) =>
              act(() => resolveFinding({ loanFileId, findingId: f.id, action, note, correctedFields }), f.id)} />
        ))}

        <div className="pill-row" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'reanalyse'}
            onClick={() => act(() => reanalyse(loanFileId), 'reanalyse')}>
            {busy === 'reanalyse' ? 'Re-running…' : 'Re-run the analysis'}
          </button>
        </div>
      </div>

      {decided.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Already reviewed</h2><span className="chip gray">{decided.length}</span></div>
          {/* Kept visible rather than archived: "why is this not flagged?" is asked far more
              often than "what is flagged?", and the answer is here. */}
          {decided.map((f) => (
            <div key={f.id} className="row" style={{ display: 'block' }}>
              <div className="spread">
                <div className="rlabel">{CATEGORY_LABEL[f.category] || f.category}</div>
                <span className="chip gray">{f.status}</span>
              </div>
              <p className="mb0 muted" style={{ fontSize: 13 }}>{f.explanation}</p>
              {f.resolutionNote && <p className="mb0 hint">“{f.resolutionNote}”</p>}
            </div>
          ))}
        </div>
      )}

      {/* ── Programs ──────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head"><h2>Programs worth pursuing</h2></div>
        <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
          Suitability, not eligibility. Each line says which published guideline it was measured
          against — nothing here is an approval, and none of it has been through underwriting.
        </p>
        {programs.unknowns.length > 0 && (
          <p className="hint">Measured without: {programs.unknowns.join(', ')}. Those comparisons are assumptions until the numbers exist.</p>
        )}
        {programs.suitable.map((p) => (
          <div key={p.key} className="row" style={{ display: 'block' }}>
            <div className="spread"><div className="rlabel">{p.label}</div><span className="chip gray">{p.guideline}</span></div>
            <p className="mb0 muted" style={{ fontSize: 13 }}>{p.note}</p>
            {p.assumptions.length > 0 && (
              <p className="mb0 hint">Assumes: {p.assumptions.join('; ')}.</p>
            )}
          </div>
        ))}
        {programs.notSuitable.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="muted">Ruled out ({programs.notSuitable.length}) — and why</summary>
            {programs.notSuitable.map((p) => (
              <div key={p.key} className="row" style={{ display: 'block' }}>
                <div className="rlabel">{p.label}</div>
                <p className="mb0 muted" style={{ fontSize: 13 }}>{p.reasons.join('; ')}</p>
              </div>
            ))}
          </details>
        )}
        <p className="hint" style={{ marginTop: 14 }}>
          <b>Not examined:</b> {programs.notChecked.join(', ')}.
        </p>
      </div>

      <p className="muted" style={{ fontSize: 12.5, marginTop: 22 }}>
        Everything on this page is internal. It is not shared with the borrower, and it is not an
        approval, a pre-approval, a credit decision, or a commitment to lend. A licensed person
        makes every decision on this file.
      </p>
    </div>
  )
}

// A number, or an honest blank. A dash here means "not computable yet" and the basis line says
// what is missing — never a plausible-looking figure derived from an input nobody has.
function Fact({ label, value, basis, money, pct, warn }) {
  const shown = value === null || value === undefined
    ? '—'
    : (money ? `$${Math.round(value).toLocaleString('en-US')}` : (pct ? `${value}%` : value))
  return (
    <div className="row">
      <div className="spread">
        <div className="rlabel">{label}</div>
        <div>
          <strong>{shown}</strong>
          {warn && <span className="chip amber" style={{ marginLeft: 6 }}>check</span>}
        </div>
      </div>
      {basis && <p className="mb0 muted" style={{ fontSize: 12.5 }}>{basis}</p>}
    </div>
  )
}

function Metric({ label, v, extra }) {
  return (
    <div className="metric">
      <span className="lbl">{label}</span>
      <span className="big-num">{v.percent}%</span>
      <span className="lbl">{extra}</span>
    </div>
  )
}

function Finding({ f, busy, onResolve }) {
  const [openDetail, setOpenDetail] = useState(false)
  const [mode, setMode] = useState(null)
  const [note, setNote] = useState('')
  const [value, setValue] = useState('')
  const working = busy === f.id

  return (
    <div className="row" style={{ display: 'block', marginBottom: 12 }}>
      <div className="spread">
        <div className="rlabel">{CATEGORY_LABEL[f.category] || f.category}</div>
        <div className="pill-row">
          <span className={SEVERITY_CHIP[f.severity] || 'chip gray'}>{f.severity}</span>
          {f.minConfidence != null && f.needsHumanReview && (
            <span className="chip amber">read at {Math.round(f.minConfidence * 100)}%</span>
          )}
        </div>
      </div>

      {/* The explanation names the reason, not the symptom — that is a rule-engine invariant,
          and it is why this renders as a sentence rather than a code. */}
      <p style={{ marginTop: 6 }}>{f.explanation}</p>

      {f.documents.length > 0 && (
        <p className="hint mb0">From: {f.documents.map((d) => d.label).join(', ')}</p>
      )}

      <button type="button" className="linklike" onClick={() => setOpenDetail((v) => !v)}>
        {openDetail ? '▾' : '▸'} What it read
      </button>
      {openDetail && (
        <ul className="c1003-reasons">
          {f.evidence.map((e, i) => (
            <li key={`${e.docKey}:${e.field}:${i}`}>
              <code>{e.field}</code> = {String(e.value ?? '—')} <span className="muted">({e.docKey}
              {e.confidence != null ? `, ${Math.round(e.confidence * 100)}% confident` : ', stated'})</span>
            </li>
          ))}
        </ul>
      )}

      {!mode && (
        <div className="pill-row" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-sm" disabled={working} onClick={() => onResolve('confirm')}>
            Confirm — it is real
          </button>
          <button type="button" className="btn btn-sm" disabled={working} onClick={() => setMode('correct')}>
            The reading was wrong
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={working} onClick={() => setMode('dismiss')}>
            Not an issue here
          </button>
        </div>
      )}

      {mode === 'dismiss' && (
        <div style={{ marginTop: 8 }}>
          {/* Required, not optional. A dismissal with no reason is the one that cannot be
              defended when somebody asks about it a year from now. */}
          <div className="field">
            <label htmlFor={`n-${f.id}`}>Why is this not an issue on this file?</label>
            <input id={`n-${f.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </div>
          <div className="pill-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={working || !note.trim()}
              onClick={() => onResolve('dismiss', note.trim())}>Dismiss</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'correct' && (
        <div style={{ marginTop: 8 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            A correction is the most useful thing you can record here — it is the case where the
            reading or the rule was wrong, described by someone who knew better.
          </p>
          <div className="grid2">
            <div className="field">
              <label htmlFor={`v-${f.id}`}>The correct value</label>
              <input id={`v-${f.id}`} value={value} onChange={(e) => setValue(e.target.value)} maxLength={300} />
            </div>
            <div className="field">
              <label htmlFor={`cn-${f.id}`}>Note (optional)</label>
              <input id={`cn-${f.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </div>
          </div>
          <div className="pill-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={working || !value.trim()}
              onClick={() => onResolve('correct', note.trim() || null,
                [{ field: f.evidence[0]?.field || f.rule, value: value.trim(), docKey: f.evidence[0]?.docKey || null }])}>
              Save the correction
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
