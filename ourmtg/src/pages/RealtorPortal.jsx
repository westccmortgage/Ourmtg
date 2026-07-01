// Realtor portal (spec §K.7): a milestone-only list of referred buyers (NO financials —
// enforced by the gateway's realtor view), plus submit-a-buyer, a co-branded intake link,
// and an open-house QR code. Each buyer's milestone comes from portal-status, which for a
// realtor returns a coarse milestone + est. close + LO-published pre-approval band only.
import { useEffect, useState } from 'react'
import { getStatus } from '../lib/api'
import { useAuth } from '../lib/auth'
import { money, shortDate } from '../lib/format'
import { Alert, Spinner, Empty } from '../components/ui'
import SubmitBuyerForm from '../components/SubmitBuyerForm'
import QRCode from '../components/QRCode'

export default function RealtorPortal({ grants }) {
  const { user } = useAuth()
  const [buyers, setBuyers] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const partner = { name: user?.user_metadata?.full_name || null, email: user?.email || null }
  const coBrandedLink = `${window.location.origin}/apply?ref=${encodeURIComponent(user?.email || 'realtor')}`

  useEffect(() => {
    let alive = true
    Promise.all(grants.map((g) => getStatus(g.loan_file_id).catch(() => null)))
      .then((rows) => { if (alive) setBuyers(rows.filter(Boolean)) })
      .catch((err) => { if (alive) setError(err?.message || 'Could not load your buyers.') })
    return () => { alive = false }
  }, [grants])

  async function copyLink() {
    try { await navigator.clipboard.writeText(coBrandedLink); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* ignore */ }
  }

  return (
    <>
      <h1>Partner portal</h1>

      <div className="card">
        <div className="card-head"><h2>Your referred buyers</h2>{buyers && <span className="chip gray">{buyers.length}</span>}</div>
        {!buyers && !error && <Spinner />}
        {error && <Alert kind="error">{error}</Alert>}
        {buyers && buyers.length === 0 && <Empty>No referred buyers yet. Submit one below and you’ll see their milestones here.</Empty>}
        {buyers && buyers.map((b) => (
          <div className="row" key={b.loanFileId}>
            <div className="grow">
              <div className="rlabel">{b.borrowerName || 'Your buyer'}</div>
              <div className="rsub">
                {b.estCloseDate ? `Est. close ${shortDate(b.estCloseDate)}` : 'Timeline TBD'}
                {b.preApproval && <span> · Pre-approved up to {money(b.preApproval.amount)}{b.preApproval.expires ? ` (through ${shortDate(b.preApproval.expires)})` : ''}</span>}
              </div>
            </div>
            <span className="chip">{b.milestone}</span>
          </div>
        ))}
        <p className="hint" style={{ marginTop: 12 }}>Milestones only — you’ll never see your buyer’s income, assets, credit, or documents.</p>
      </div>

      <div className="card">
        <div className="card-head"><h2>Submit a buyer</h2></div>
        <SubmitBuyerForm partner={partner} />
      </div>

      <div className="card">
        <h2>Your co-branded link</h2>
        <p className="muted">Send this to buyers so their application is attributed to you.</p>
        <div className="field">
          <input readOnly value={coBrandedLink} onFocus={(e) => e.target.select()} />
        </div>
        <button className="btn btn-ghost btn-sm" onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        <div className="qrbox" style={{ marginTop: 20 }}>
          <QRCode value={coBrandedLink} />
          <p className="hint" style={{ marginTop: 10 }}>Open-house QR — buyers scan to start with you attributed.</p>
        </div>
      </div>
    </>
  )
}
