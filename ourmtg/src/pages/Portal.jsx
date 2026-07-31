// Authenticated dispatcher. Detects the user's role(s) and renders the matching home:
// borrower dashboard, realtor portal, or LO dashboard. If more than one applies (rare),
// a small switcher lets the user change view via ?as=. A signed-in user with no access
// yet gets a ROLE CHOOSER — big obvious doors, never a dead end.
import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { pendingInvite } from '../lib/pendingInvite'
import { inviteHref } from '../lib/inviteDestination'
import { useAuth } from '../lib/auth'
import { useRole } from '../lib/useRole'
import { Alert, Spinner } from '../components/ui'
import BorrowerDashboard from './BorrowerDashboard'
import RealtorPortal from './RealtorPortal'
import LODashboard from './LODashboard'
import InternalWorkspace from '../components/InternalWorkspace'

const ROLE_LABEL = { borrower: 'My loan', realtor: 'Partner portal', lo: 'Loan team' }

// Paste-an-invite fallback: email apps sometimes mangle links; let people paste the
// whole invite URL (or just the 32-hex token) and we route them to acceptance.
function InvitePaste() {
  const navigate = useNavigate()
  const [val, setVal] = useState('')
  const [bad, setBad] = useState(false)
  function go(e) {
    e.preventDefault()
    const m = /([0-9a-f]{32})/i.exec(val)
    if (!m) { setBad(true); return }
    // A pasted link usually carries where it was meant to open. Dropping that would land an
    // application link on the dashboard — the same disappearing destination the rest of this
    // flow works to prevent.
    const d = /[?&]go=(application|documents)\b/i.exec(val)
    navigate(inviteHref(m[1], d ? d[1].toLowerCase() : ''))
  }
  return (
    <form onSubmit={go} style={{ marginTop: 10 }}>
      <div className="spread">
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <input value={val} onChange={(e) => { setVal(e.target.value); setBad(false) }}
            placeholder="Paste your invite link here…" />
        </div>
        <button className="btn btn-ghost btn-sm">Open</button>
      </div>
      {bad && <p className="hint" style={{ color: 'var(--stamp)' }}>That doesn’t look like an invite link — it should contain a long code. Ask your loan officer to resend it.</p>}
    </form>
  )
}

export default function Portal() {
  const { user } = useAuth()
  const { loading, error, roles, grants, ownedFiles } = useRole()
  const [params, setParams] = useSearchParams()
  // Read once per mount: redeeming navigates away, and a value that changed underneath would
  // re-trigger the redirect.
  const [parked] = useState(pendingInvite)

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>

  if (roles.length === 0) {
    // Someone who was invited must never be asked who they are. If an invite is parked from
    // before sign-in, redeem it instead of showing a chooser — this is the exact dead end an
    // invited borrower lands in after clicking the account-confirmation email.
    if (parked) {
      return <Navigate to={inviteHref(parked.token, parked.go)} replace />
    }
    return (
      <div style={{ maxWidth: 520, margin: '8px auto' }}>
        <p className="fileno">Signed in as {user?.email || 'you'} · no file linked yet</p>
        <h1 style={{ marginBottom: 6 }}>You’re in.<br /><span style={{ color: 'var(--muted)' }}>What brings you here?</span></h1>
        <p className="muted" style={{ marginBottom: 22 }}>Pick your door — everything else follows from this.</p>

        {/* Invited borrowers come first. They are the only people here who were SENT somewhere
            specific, and sending them into the marketing flow instead — which mints a throwaway
            draft number and promises a callback — strands them further from their real file. */}
        <div className="card">
          <h2 className="mb0">My loan officer invited me</h2>
          <p className="mb0 muted" style={{ fontSize: 13.5 }}>
            Open the invite link from your email — it connects this account to your loan file.
            The invite is a different message from the one that confirmed your email address.
            Can’t click it? Paste it below.
          </p>
          <InvitePaste />
        </div>

        <Link to="/plan" className="card linkcard">
          <div className="spread">
            <div>
              <h2 className="mb0">Nobody sent me — I’m just starting out</h2>
              <p className="mb0 muted" style={{ fontSize: 13.5 }}>Build your plan in 60 seconds — route, price range, programs. No paperwork yet.</p>
            </div>
            <span className="btn btn-ghost btn-sm">Start →</span>
          </div>
        </Link>

        <Link to="/realtor" className="card linkcard">
          <div className="spread">
            <div>
              <h2 className="mb0">I’m a realtor with a buyer</h2>
              <p className="mb0 muted" style={{ fontSize: 13.5 }}>Submit a buyer in 30 seconds — we keep you posted at every milestone.</p>
            </div>
            <span className="btn btn-ghost btn-sm">Refer →</span>
          </div>
        </Link>

        <Link to="/portal/new-file" className="card linkcard">
          <div className="spread">
            <div>
              <h2 className="mb0">I’m the loan officer / team</h2>
              <p className="mb0 muted" style={{ fontSize: 13.5 }}>Approved loan-team accounts can create the first file. Team members: ask the LO to add you.</p>
            </div>
            <span className="btn btn-ghost btn-sm">Open desk →</span>
          </div>
        </Link>
      </div>
    )
  }

  const requested = params.get('as')
  const active = roles.includes(requested) ? requested : roles[0]

  return (
    <>
      {roles.length > 1 && (
        <div className="pill-row" style={{ marginBottom: 16 }}>
          {roles.map((r) => (
            <button key={r}
              className={`btn btn-sm ${r === active ? 'btn-navy' : 'btn-ghost'}`}
              onClick={() => setParams(r === roles[0] ? {} : { as: r })}>
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      )}
      {active === 'borrower' && <div className="borrower-workspace"><BorrowerDashboard grants={grants.filter((g) => g.visibility === 'borrower' || g.visibility === 'coborrower')} /></div>}
      {active === 'realtor' && <div className="borrower-workspace"><RealtorPortal grants={grants.filter((g) => ['realtor', 'escrow', 'title'].includes(g.visibility))} /></div>}
      {active === 'lo' && <InternalWorkspace><LODashboard files={ownedFiles} /></InternalWorkspace>}
    </>
  )
}
