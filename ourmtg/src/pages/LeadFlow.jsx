// Generic lead-engine landing (spec §E.4). One component renders all flow pages
// (/dpa /fha /va /self-employed /jumbo /refi) from the FLOWS config. Each page now
// LEADS with a plain-English explainer of the program (what it is, who it fits, the
// honest trade-offs) and ends with the qualifier + contact form — a borrower should
// understand the path before they’re asked to raise their hand. Posts to lead-submit
// with the flow's own source/tag so GRCRM routing and automations branch per flow.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { submitLead } from '../lib/api'
import { flowLeadPayload, SMS_CONSENT_TEXT } from '../lib/leadFlows'
import { Alert } from '../components/ui'

// Render one content block from a flow section.
function Block({ block }) {
  if (block.p) return <p style={{ margin: '0 0 12px', color: 'var(--body)', lineHeight: 1.6 }}>{block.p}</p>
  if (block.note) return (
    <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--muted)', borderLeft: '2px solid var(--soft)', paddingLeft: 12 }}>
      {block.note}
    </p>
  )
  if (block.ul) return (
    <ul style={{ margin: '0 0 6px', paddingLeft: 18, lineHeight: 1.6, color: 'var(--body)' }}>
      {block.ul.map((li, i) => <li key={i} style={{ margin: '0 0 7px' }}>{li}</li>)}
    </ul>
  )
  if (block.rows) return (
    <div>
      {block.rows.map((r) => (
        <div className="row" key={r.t}>
          <div className="grow">
            <div className="rlabel">{r.t}</div>
            <div className="rsub" style={{ lineHeight: 1.55 }}>{r.d}</div>
          </div>
        </div>
      ))}
    </div>
  )
  return null
}

export default function LeadFlow({ flow }) {
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '', consent: false })
  const [answers, setAnswers] = useState({})
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const setC = (k) => (e) =>
    setContact((c) => ({ ...c, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const setA = (name) => (e) => setAnswers((a) => ({ ...a, [name]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!contact.consent) { setError('Please agree to be contacted so we can follow up.'); return }
    setBusy(true)
    try {
      await submitLead(flowLeadPayload(flow, contact, answers))
      setDone(true)
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 520, margin: '24px auto' }}>
        <div className="card">
          <span className="stamp">Received</span>
          <h1 style={{ marginTop: 16 }}>We’re on it.</h1>
          <p>Your answers are with the team. {`We'll reach out shortly with what you qualify for and the exact next step.`}</p>
          <Link to="/" className="btn btn-ghost">Back to home</Link>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 620, margin: '8px auto' }}>
      <Link to="/" className="backlink">← Home</Link>

      <section className="hero" style={{ padding: '12px 0 4px' }}>
        <p className="eyebrow">{flow.eyebrow}</p>
        <h1>{flow.title[0]}<br /><span className="lt">{flow.title[1]}</span></h1>
        <p className="lead">{flow.sub}</p>
        <a href="#start" className="btn btn-primary">{flow.cta}</a>
        <div className="wire" aria-hidden="true" style={{ margin: '26px 0 0' }} />
      </section>

      {/* Explainer — the borrower learns the program before being asked to raise a hand. */}
      {(flow.sections || []).map((sec) => (
        <div className="card" key={sec.h} style={{ marginTop: 20 }}>
          <div className="card-head"><h2>{sec.h}</h2></div>
          {sec.blocks.map((b, i) => <Block key={i} block={b} />)}
        </div>
      ))}

      {/* The form comes last — now that the reader knows what they’re starting. */}
      <form id="start" className="card" style={{ marginTop: 24 }} onSubmit={submit}>
        <div className="card-head"><h2>Start here</h2></div>
        {flow.formIntro ? (
          <p style={{ margin: '0 0 16px', color: 'var(--body)', lineHeight: 1.6 }}>{flow.formIntro}</p>
        ) : null}
        <Alert kind="error">{error}</Alert>
        {flow.fields.map((f) => (
          <div className="field" key={f.name}>
            <label htmlFor={`f-${f.name}`}>{f.name}</label>
            {f.type === 'select' ? (
              <select id={`f-${f.name}`} value={answers[f.name] || ''} onChange={setA(f.name)}>
                <option value="" disabled>Choose…</option>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input id={`f-${f.name}`} value={answers[f.name] || ''} onChange={setA(f.name)} placeholder={f.placeholder || ''} />
            )}
          </div>
        ))}
        <div className="grid2">
          <div className="field">
            <label htmlFor="lf-fn">First name</label>
            <input id="lf-fn" required value={contact.firstName} onChange={setC('firstName')} autoComplete="given-name" />
          </div>
          <div className="field">
            <label htmlFor="lf-ln">Last name</label>
            <input id="lf-ln" required value={contact.lastName} onChange={setC('lastName')} autoComplete="family-name" />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="lf-em">Email</label>
            <input id="lf-em" type="email" required value={contact.email} onChange={setC('email')} inputMode="email" autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="lf-ph">Mobile phone</label>
            <input id="lf-ph" type="tel" required value={contact.phone} onChange={setC('phone')} inputMode="tel" autoComplete="tel" />
          </div>
        </div>
        <div className="field checkline">
          <input id="lf-consent" type="checkbox" checked={contact.consent} onChange={setC('consent')} />
          <label htmlFor="lf-consent">{SMS_CONSENT_TEXT}</label>
        </div>
        <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
          {busy ? 'Sending…' : flow.cta}
        </button>
        <p className="hint center" style={{ marginTop: 12 }}>
          Estimates only — not a loan offer, commitment to lend, or approval.
          {flow.disclaimer ? ` ${flow.disclaimer}` : ''}
        </p>
      </form>
    </div>
  )
}
