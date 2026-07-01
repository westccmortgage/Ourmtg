// Realtor "submit a buyer" form (spec §K.8). Posts a Realtor-referral lead to GRCRM's
// lead-inbound webhook with partner attribution. Reused on the public realtor page and
// inside the authenticated realtor portal. No borrower financials are ever collected.
import { useState } from 'react'
import { submitLead } from '../lib/api'
import { realtorLeadPayload } from '../lib/leadFlows'
import { Alert } from './ui'

const EMPTY = { firstName: '', lastName: '', email: '', phone: '', priceRange: '', notes: '' }

export default function SubmitBuyerForm({ partner, onSubmitted }) {
  const [form, setForm] = useState(EMPTY)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      await submitLead(realtorLeadPayload(form, partner))
      setDone(true)
      setForm(EMPTY)
      onSubmitted?.()
    } catch (err) {
      setError(err?.message || 'Could not submit. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Alert kind="ok">
        Got your buyer — we’re on it and will keep you posted at every milestone automatically.
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setDone(false)}>Submit another buyer</button>
        </div>
      </Alert>
    )
  }

  return (
    <form onSubmit={submit}>
      <Alert kind="error">{error}</Alert>
      <div className="grid2">
        <div className="field">
          <label htmlFor="bfn">Buyer first name</label>
          <input id="bfn" required value={form.firstName} onChange={set('firstName')} />
        </div>
        <div className="field">
          <label htmlFor="bln">Buyer last name</label>
          <input id="bln" required value={form.lastName} onChange={set('lastName')} />
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="bem">Buyer email</label>
          <input id="bem" type="email" value={form.email} onChange={set('email')} inputMode="email" />
        </div>
        <div className="field">
          <label htmlFor="bph">Buyer phone</label>
          <input id="bph" type="tel" value={form.phone} onChange={set('phone')} inputMode="tel" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pr">Price range <span className="muted">(optional)</span></label>
        <input id="pr" value={form.priceRange} onChange={set('priceRange')} placeholder="$500k–$650k" />
      </div>
      <div className="field">
        <label htmlFor="nt">Notes <span className="muted">(optional)</span></label>
        <textarea id="nt" value={form.notes} onChange={set('notes')} placeholder="Timeline, must-haves, anything helpful…" />
      </div>
      <p className="hint">Provide at least an email or phone so we can reach your buyer.</p>
      <button className="btn btn-navy btn-block btn-lg" disabled={busy}>
        {busy ? 'Submitting…' : 'Submit buyer'}
      </button>
    </form>
  )
}
