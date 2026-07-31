// Invite redemption (spec §K.2 tail). The LO mints an invite link (/invite?token=…);
// after the invitee signs in via magic link, this calls portal-invite-accept to mint the
// portal_access grant (identity-bound, single-use), then routes into the portal.
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { acceptInvite } from '../lib/api'
import { landingPath, inviteHref } from '../lib/inviteDestination'
import { Alert, Spinner } from '../components/ui'

export default function Invite() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const go = params.get('go') || ''
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState('working') // working | error
  const [error, setError] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (loading || !user || ran.current || !token) return
    ran.current = true
    acceptInvite(token)
      .then((r) => {
        navigate(landingPath(go, r?.loanFileId), { replace: true, state: { justJoined: r?.role } })
      })
      .catch((err) => { setError(err?.message || 'This invite could not be accepted.'); setState('error') })
  }, [loading, user, token, go, navigate])

  if (!token) {
    return <Alert kind="error">This link is missing its invite token. Please use the exact link from your email.</Alert>
  }
  if (loading) return <Spinner />
  // Not signed in yet → send to login, then return here to finish accepting.
  // The destination has to survive the sign-in round trip, or every emailed application link
  // would quietly degrade into a plain portal link for anyone not already signed in.
  if (!user) return <Navigate to="/login" state={{ from: inviteHref(token, go) }} replace />

  if (state === 'error') {
    return (
      <div style={{ maxWidth: 460, margin: '24px auto' }}>
        <div className="card">
          <h1>We couldn’t open your portal</h1>
          <Alert kind="error">{error}</Alert>
          <p className="muted">If your link expired or was already used, ask your loan officer to send a fresh one.</p>
          <Link to="/portal" className="btn btn-ghost">Go to my portal</Link>
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
