// Create a loan file manually (standalone mode — no GRCRM projector feeding files).
// The signed-in user becomes the file's owner/LO; from the file detail they then
// invite the borrower, request documents, and advance the stage by hand.
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { setLoanFile } from '../lib/api'
import { LOAN_TYPES, PURPOSES } from '../lib/leadFlows'
import { Alert } from '../components/ui'

export default function NewLoanFile() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    borrowerName: '', loanType: 'Conventional', purpose: 'Purchase',
    amount: '', estCloseDate: '', loanNumber: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await setLoanFile({
        borrowerName: form.borrowerName,
        loanType: form.loanType,
        purpose: form.purpose,
        amount: form.amount || null,
        estCloseDate: form.estCloseDate || null,
        loanNumber: form.loanNumber || null,
      })
      navigate(`/portal/file/${r.loanFileId}`, { replace: true })
    } catch (err) {
      setError(err?.message || 'Could not create the loan file.')
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '8px auto' }}>
      <Link to="/portal" className="backlink">← Back to dashboard</Link>
      <h1>New loan file</h1>
      <p className="muted">Creates the file you and your team will work. Next step: open it and invite the borrower.</p>
      <form className="card" onSubmit={submit}>
        <Alert kind="error">{error}</Alert>
        <div className="field">
          <label htmlFor="nb">Borrower name</label>
          <input id="nb" required value={form.borrowerName} onChange={set('borrowerName')} maxLength={120} />
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="nlt">Loan type</label>
            <select id="nlt" value={form.loanType} onChange={set('loanType')}>
              {LOAN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="npp">Purpose</label>
            <select id="npp" value={form.purpose} onChange={set('purpose')}>
              {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="nam">Loan amount <span className="muted">(optional)</span></label>
            <input id="nam" type="number" min="0" value={form.amount} onChange={set('amount')} placeholder="650000" />
          </div>
          <div className="field">
            <label htmlFor="ncd">Est. close date <span className="muted">(optional)</span></label>
            <input id="ncd" type="date" value={form.estCloseDate} onChange={set('estCloseDate')} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="nln">Loan number <span className="muted">(optional)</span></label>
          <input id="nln" value={form.loanNumber} onChange={set('loanNumber')} maxLength={60} />
        </div>
        <button className="btn btn-primary btn-block btn-lg" disabled={busy || !form.borrowerName.trim()}>
          {busy ? 'Creating…' : 'Create loan file'}
        </button>
      </form>
    </div>
  )
}
