// /1003/:token — the short form of an application invite.
//
// It exists to be pasted into a text message and read aloud on a phone call. "ourmtg.com/1003/
// a1b2…" is something you can say; "ourmtg.com/invite?token=a1b2…&go=application" is not.
//
// It carries the same token and redeems through the same path, so it is shorter without being
// weaker: identity binding, expiry, and single use all still happen in portal-invite-accept.
// This component only rewrites the URL shape — it never grants anything.
import { Navigate, useParams } from 'react-router-dom'
import { inviteHref, isInviteToken } from '../lib/inviteDestination'
import { Alert } from '../components/ui'

export default function ShortLink1003() {
  const { token = '' } = useParams()
  if (!isInviteToken(token)) {
    return (
      <div style={{ maxWidth: 460, margin: '24px auto' }}>
        <div className="card">
          <h1>That link looks incomplete</h1>
          <Alert kind="error">This application link isn’t valid.</Alert>
          <p className="muted">
            Text links sometimes get cut off in transit. Ask whoever sent it to send it again, or
            open the full link from your email.
          </p>
        </div>
      </div>
    )
  }
  return <Navigate to={inviteHref(token, 'application')} replace />
}
