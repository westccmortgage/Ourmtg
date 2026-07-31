// /application — "take me to my application", with no id in the URL.
//
// This is what 1003.ourmtg.com resolves to. Someone reaching it typed or tapped a short address
// rather than a link built for them, so the loan file has to be worked out from who they are:
//
//   • exactly one file  → straight in, no interstitial to click through
//   • several           → ask which, rather than guessing
//   • none              → say so plainly and point at the portal's invite-paste box, because the
//                         usual cause is an invite link that was never redeemed
//
// The borrower-side grants are the only ones offered. A loan officer landing here has no
// application of their own to fill out; they belong on the file, reviewing someone else's.
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useRole } from '../lib/useRole'
import { resolveMyApplication } from '../lib/inviteDestination'
import { Alert, Spinner } from '../components/ui'

export default function ApplicationEntry() {
  const { user, loading: authLoading } = useAuth()
  const { loading, error, grants } = useRole()

  if (authLoading) return <Spinner />
  // Sign in, then come back here — not to the portal, or the short address quietly stops
  // meaning "my application" for everyone who wasn't already signed in.
  if (!user) return <Navigate to="/login" state={{ from: '/application' }} replace />
  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>

  const target = resolveMyApplication(grants)

  if (target.kind === 'one') {
    return <Navigate to={`/application/assistant/${target.loanFileId}`} replace />
  }

  if (target.kind === 'choose') {
    const mine = target.files
    return (
      <div style={{ maxWidth: 520, margin: '8px auto' }}>
        <p className="fileno">Signed in as {user.email}</p>
        <h1 style={{ marginBottom: 6 }}>Which loan?</h1>
        <p className="muted" style={{ marginBottom: 22 }}>You’re on more than one file. Pick the one you want to work on.</p>
        {/* The grant rows carry the file id and the role and nothing else — no borrower name —
            so the file number is what identifies them here. */}
        {mine.map((g) => (
          <Link key={g.loan_file_id} to={`/application/assistant/${g.loan_file_id}`} className="card linkcard">
            <div className="spread">
              <div>
                <h2 className="mb0">File № {String(g.loan_file_id).slice(0, 8).toUpperCase()}</h2>
                <p className="mb0 muted">{g.visibility === 'coborrower' ? 'You’re the co-borrower' : 'You’re the borrower'}</p>
              </div>
              <span className="btn btn-primary btn-sm">Open →</span>
            </div>
          </Link>
        ))}
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 520, margin: '8px auto' }}>
      <p className="fileno">Signed in as {user.email} · no file linked yet</p>
      <h1 style={{ marginBottom: 6 }}>No application here yet</h1>
      <p className="muted" style={{ marginBottom: 22 }}>
        An application belongs to a loan file, and your account isn’t on one. If your loan officer
        sent you a link, opening it is what connects the two.
      </p>
      <div className="card">
        <div className="card-head"><h2>Have a link?</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>
          Your portal has a box to paste it into — the whole link, or just the long code from it.
          Email apps break links often enough that it’s worth trying there.
        </p>
        <Link to="/portal" className="btn btn-primary btn-sm">Go to my portal</Link>
      </div>
    </div>
  )
}
