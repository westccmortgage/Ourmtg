// The page a WCCM employee keeps open in one window while they type this file into ARIVE.
//
// ── This is not an integration ──────────────────────────────────────────────
// Nothing on this page sends anything anywhere. ARIVE is the system of record and a person puts
// the file into it; what this removes is the hunting — opening six PDFs and a chat transcript to
// find out what the borrower said their employer was. The disclaimer is rendered first, before
// anything that could be mistaken for a submission, and it comes from the server as data so this
// component cannot decide to leave it off.
//
// ── Printing is a first-class use ───────────────────────────────────────────
// Half the people who key a file work from paper. So the layout is a single column of
// label → value rows, the cards break cleanly, and the print stylesheet drops the chrome. No
// "export" button that produces a worse version of what the browser already does well.

import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getAriveHandoff } from '../lib/api'
import { Alert, Spinner } from '../components/ui'

export default function AriveHandoff() {
  const { loanFileId } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)

  const load = useCallback(() => getAriveHandoff(loanFileId).then(setData), [loanFileId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    load().catch((e) => { if (alive) setError(e?.message || 'Could not build the entry sheet.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [load])

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return null

  return (
    <div className="handoff">
      <style>{PRINT_CSS}</style>

      <Link to={`/portal/file/${loanFileId}/pre-underwriting`} className="backlink no-print">← Back to pre-underwriting</Link>

      <div className="spread">
        <h1 className="mb0">ARIVE entry sheet</h1>
        <button type="button" className="btn btn-ghost btn-sm no-print" onClick={() => window.print()}>Print</button>
      </div>

      {/* First, before anything that could be read as a submission. */}
      <Alert kind="warn">
        <b>Nothing has been sent to ARIVE.</b>{' '}
        {data.transfer?.note || 'This file is not in ARIVE until someone enters it.'}
      </Alert>

      {!data.ready ? (
        <div className="card"><div className="row"><div className="grow">
          <p className="mb0">{data.reason}</p>
        </div></div></div>
      ) : (
        <Sheet data={data} hideEmpty={hideEmpty} onToggleEmpty={() => setHideEmpty((v) => !v)} />
      )}
    </div>
  )
}

function Sheet({ data, hideEmpty, onToggleEmpty }) {
  const { sheet, operational } = data
  return (
    <>
      <div className="card">
        <div className="card-head"><h2>{sheet.header.borrowerName || 'This file'}</h2>
          <span className="chip gray">{operational.percent}% operationally complete</span>
        </div>
        <div className="row"><div className="grow">
          <div className="rsub muted">Loan number: {sheet.header.loanNumber || '—'}</div>
          <div className="rsub muted">Prepared {new Date(sheet.header.generatedAt).toLocaleString()}</div>
          {/* The number never travels without its meaning, on this page as on every other. */}
          <div className="rsub muted" style={{ marginTop: 6 }}>
            {operational.meaning} It is not {operational.notMeaning.join(', not ')}.
          </div>
        </div></div>
        <div className="row"><div className="grow">
          <span className="chip">{sheet.counts.filled} filled</span>{' '}
          <span className="chip">{sheet.counts.missing} still blank</span>{' '}
          <span className="chip">{sheet.counts.redacted} collect in ARIVE</span>{' '}
          <span className="chip">{sheet.counts.unconfirmed} unconfirmed</span>
        </div></div>
      </div>

      {sheet.contradictions.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Ask before entering</h2></div>
          {sheet.contradictions.map((c) => (
            <div className="row" key={c.path}><div className="grow">
              <div className="rlabel">{c.label}</div>
              <div className="rsub" style={{ color: 'var(--red)' }}>{c.note}</div>
            </div></div>
          ))}
        </div>
      )}

      <div className="card no-print">
        <div className="row"><div className="grow">
          <label>
            <input type="checkbox" checked={hideEmpty} onChange={onToggleEmpty} />{' '}
            Hide the fields that are still blank
          </label>
          <div className="rsub muted" style={{ marginTop: 4 }}>
            They are shown by default: a blank box you cannot see is a blank box that gets skipped.
          </div>
        </div></div>
      </div>

      {sheet.sections.map((s) => {
        const rows = hideEmpty ? s.rows.filter((r) => !r.missing) : s.rows
        if (!rows.length) return null
        return (
          <div className="card page-break" key={s.key}>
            <div className="card-head"><h2>{s.title}</h2></div>
            {rows.map((r) => (
              <div className="row" key={r.path}>
                <div className="grow">
                  <div className="rlabel">{r.label}</div>
                  {r.urla && <div className="rsub muted">URLA {r.urla}</div>}
                </div>
                <div style={{ flex: '1 1 50%', textAlign: 'right' }}>
                  <div style={{ fontWeight: r.missing ? 400 : 600 }}>
                    {r.redacted ? <span className="muted">— collect in ARIVE —</span>
                      : r.missing ? <span className="muted">— blank —</span>
                        : r.value}
                  </div>
                  {r.note && !r.redacted && <div className="rsub muted">{r.note}</div>}
                  {r.redacted && <div className="rsub muted">{r.note}</div>}
                </div>
              </div>
            ))}
          </div>
        )
      })}

      {sheet.documents && (
        <div className="card page-break">
          <div className="card-head">
            <h2>Documents on file</h2>
            <span className="chip">{sheet.documents.total} total · {sheet.documents.unread} not read</span>
          </div>
          {sheet.documents.sections.map((s) => (
            <div key={s.key}>
              <div className="row"><div className="grow"><b>{s.title}</b></div></div>
              {s.files.map((f) => (
                <div className="row" key={f.filedAs + f.originalName}>
                  <div className="grow">
                    <div className="rlabel">{f.filedAs}</div>
                    {/* The borrower's own filename, always shown: the stored file still has it,
                        and that is how someone finds the original a year from now. */}
                    <div className="rsub muted">uploaded as “{f.originalName}”</div>
                  </div>
                  <div style={{ flex: '0 0 auto' }}>
                    <span className={`chip ${f.read ? 'green' : 'gray'}`}>{f.read ? 'read' : 'not read'}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// Scoped to this page. The only thing it changes about printing is dropping the app chrome and
// keeping a section from breaking across a page mid-row.
const PRINT_CSS = `
@media print {
  .no-print, header, nav, footer { display: none !important; }
  .handoff .card { break-inside: avoid; box-shadow: none; border: 1px solid #ddd; }
  .handoff .page-break { break-before: auto; }
  .handoff .row { break-inside: avoid; }
  a[href]:after { content: ""; }
}
`
