// Invite redemption (spec §K.2 tail). The LO mints an invite link (/invite?token=…);
// after the invitee signs in with Google or an email link, this calls portal-invite-accept to mint the
// portal_access grant (identity-bound, single-use), then routes into the portal.
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { acceptInvite } from '../lib/api'
import { landingPath, inviteHref } from '../lib/inviteDestination'
import { rememberInvite, forgetInvite } from '../lib/pendingInvite'
import { Alert, Spinner } from '../components/ui'

export default function Invite() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const go = params.get('go') || ''
  const { user, loading, signOut } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState('working') // working | error
  const [error, setError] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (loading || !user || ran.current || !token) return
    ran.current = true
    acceptInvite(token)
      .then((r) => {
        // Redeemed — nothing left to come back for, either way it resolved.
        forgetInvite()
        navigate(landingPath(go, r?.loanFileId), { replace: true, state: { justJoined: r?.role } })
      })
      .catch((err) => {
        forgetInvite()
        setError(err?.message || 'This invite could not be accepted.'); setState('error')
      })
  }, [loading, user, token, go, navigate])

  if (!token) {
    return <Alert kind="error">This link is missing its invite token. Please use the exact link from your email.</Alert>
  }
  if (loading) return <Spinner />
  // Not signed in yet → send to login, then return here to finish accepting.
  // The destination has to survive the sign-in round trip, or every emailed application link
  // would quietly degrade into a plain portal link for anyone not already signed in. Router
  // state covers the case where they come straight back; localStorage covers the far more
  // common one, where signing in means going to a mail app and clicking the confirmation
  // message instead — which lands them back here with the state gone.
  if (!user) {
    rememberInvite(token, go)
    return <Navigate to="/login" state={{ from: inviteHref(token, go) }} replace />
  }

  if (state === 'error') {
    // The most common failure by far is the wrong account, not a broken link — and "issued to a
    // different email" tells someone nothing when the screen does not also say which account
    // they are currently signed in as. Naming both makes the fix obvious.
    const wrongAccount = /different email|different phone/i.test(error)
    return (
      <div style={{ maxWidth: 460, margin: '24px auto' }}>
        <div className="card">
          <h1>{wrongAccount ? 'This link is for a different account' : 'We couldn’t open your portal'}</h1>
          <Alert kind="error">{error}</Alert>
          {wrongAccount ? (
            <>
              <p className="muted">
                You’re signed in as <b>{user?.email || 'this account'}</b>, and this invite was
                issued to someone else. Sign out, then open the link again and sign in with the
                address your loan officer sent it to.
              </p>
              <div className="pill-row">
                {/* Park the token first: after signing out this tab navigates to /login, and the
                    borrower will finish the trip through their mail app, where router state is
                    long gone. The parked copy is what brings them back to this invite. */}
                <button type="button" className="btn btn-primary btn-sm"
                        onClick={async () => { rememberInvite(token, go); await signOut(); navigate('/login', { replace: true }) }}>
                  Sign out and switch account
                </button>
                <Link to="/portal" className="btn btn-ghost btn-sm">Go to my portal</Link>
              </div>
            </>
          ) : (
            <>
              <p className="muted">If your link expired or was already used, ask your loan officer to send a fresh one.</p>
              <Link to="/portal" className="btn btn-ghost">Go to my portal</Link>
            </>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="center" style={{ padding: '48px 0' }}>
      <Spinner />
      <p className="muted">Setting up your secure portal…</p>
    </div>
  )
}
