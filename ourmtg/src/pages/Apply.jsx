// Borrower intake (spec §F.1, §K). Form-based (not conversational AI yet) → posts the
// shared lead shape to GRCRM's lead-inbound webhook. Captures explicit TCPA/e-consent
// with the exact disclosure text. On success the borrower is told they'll get a secure
// link by text/email (the LO then mints a portal invite from GRCRM).
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { submitLead } from '../lib/api'
import { borrowerLeadPayload, LOAN_TYPES, PURPOSES, SMS_CONSENT_TEXT } from '../lib/leadFlows'
import { Alert } from '../components/ui'

const EMPTY = { firstName: '', lastName: '', email: '', phone: '', loanType: 'Conventional', purpose: 'Purchase', message: '', consent: false }

export default function Apply() {
  const [params] = useSearchParams()
  const [form, setForm] = useState(EMPTY)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!form.consent) { setError('Please agree to be contacted so we can help with your loan.'); return }
    setBusy(true)
    try {
      const payload = borrowerLeadPayload(form)
      // Carry a realtor partner attribution through if the borrower arrived via a co-branded link.
      const ref = params.get('ref')
      if (ref) payload.referredBy = { ref }
      await submitLead(payload)
      setDone(true)
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 480, margin: '24px auto' }}>
        <div className="card center">
          <h1>You’re in — thank you! 🎉</h1>
          <p>We received your information. Your loan officer with West Coast Capital Mortgage will
            reach out shortly with your secure portal link so you can upload documents and track
            everything in one place.</p>
          <Link to="/" className="btn btn-ghost">Back to home</Link>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 560, margin: '8px auto' }}>
      <Link to="/" className="backlink">← Home</Link>
      <h1>Start your application</h1>
      <p className="muted">Takes about 3 minutes. This starts your file — no credit pull happens here.</p>
      <form className="card" onSubmit={submit}>
        <Alert kind="error">{error}</Alert>
        <div className="grid2">
          <div className="field">
            <label htmlFor="fn">First name</label>
            <input id="fn" required value={form.firstName} onChange={set('firstName')} autoComplete="given-name" />
          </div>
          <div className="field">
            <label htmlFor="ln">Last name</label>
            <input id="ln" required value={form.lastName} onChange={set('lastName')} autoComplete="family-name" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="em">Email</label>
          <input id="em" type="email" required value={form.email} onChange={set('email')} autoComplete="email" inputMode="email" />
        </div>
        <div className="field">
          <label htmlFor="ph">Mobile phone</label>
          <input id="ph" type="tel" required value={form.phone} onChange={set('phone')} autoComplete="tel" inputMode="tel" />
          <p className="hint">We’ll text your secure link here.</p>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="lt">Loan type</label>
            <select id="lt" value={form.loanType} onChange={set('loanType')}>
              {LOAN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pp">Purpose</label>
            <select id="pp" value={form.purpose} onChange={set('purpose')}>
              {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="msg">Anything we should know? <span className="muted">(optional)</span></label>
          <textarea id="msg" value={form.message} onChange={set('message')} placeholder="Timeline, property address, questions…" />
        </div>
        <div className="field checkline">
          <input id="consent" type="checkbox" checked={form.consent} onChange={set('consent')} />
          <label htmlFor="consent">{SMS_CONSENT_TEXT}</label>
        </div>
        <button className="btn btn-primary btn-block btn-lg" disabled={busy}>
          {busy ? 'Submitting…' : 'Start my application'}
        </button>
        <p className="hint center" style={{ marginTop: 12 }}>
          Estimates only — not a loan offer, commitment to lend, or approval.
        </p>
      </form>
    </div>
  )
}
