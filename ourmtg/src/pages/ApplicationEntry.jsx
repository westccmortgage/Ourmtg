// /application — "take me to my application", with no id in the URL.
//
// This is what 1003.ourmtg.com resolves to. Someone reaching it typed or tapped a short address
// rather than a link built for them, so the loan file has to be worked out from who they are:
//
//   • exactly one file  → straight in, no interstitial to click through
//   • several           → ask which, rather than guessing
//   • none              → depends on who they are, and getting this wrong is what made the page
//                         useless: the loan officer who owns every file on the system has no
//                         borrower grant either, so they were told to ask their loan officer for
//                         a link. They ARE the loan officer. For them this address means the
//                         other half of the same sentence — not "open my application" but
//                         "send someone theirs" — so the send box is the page.
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useRole } from '../lib/useRole'
import { resolveMyApplication, inviteHref } from '../lib/inviteDestination'
import { pendingInvite } from '../lib/pendingInvite'
import { Alert, Spinner } from '../components/ui'
import SendAssistant from '../components/SendAssistant'

export default function ApplicationEntry() {
  const { user, loading: authLoading } = useAuth()
  const { loading, error, grants, roles, ownedFiles } = useRole()

  if (authLoading) return <Spinner />
  // Sign in, then come back here — not to the portal, or the short address quietly stops
  // meaning "my application" for everyone who wasn't already signed in.
  if (!user) return <Navigate to="/login" state={{ from: '/application' }} replace />
  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>

  // Same rescue as the portal: an invite parked before sign-in beats telling someone they have
  // no application. They were sent here precisely because they do.
  const parked = pendingInvite()
  if (parked && resolveMyApplication(grants).kind === 'none') {
    return <Navigate to={inviteHref(parked.token, parked.go || 'application')} replace />
  }

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

  // ── the loan team ────────────────────────────────────────────────────────
  // No borrower grant, but they own files — or the review queue told us they are internal.
  if (roles.includes('lo')) {
    return (
      <div style={{ maxWidth: 620, margin: '8px auto' }}>
        <p className="fileno">Signed in as {user.email} · loan team</p>
        <h1 style={{ marginBottom: 6 }}>Send someone the 1003</h1>
        <p className="muted" style={{ marginBottom: 22 }}>
          An application belongs to the borrower, so there isn’t one here for you to fill out —
          you send them the link and review what comes back. Name and a way to reach them is all
          it takes; the interview asks for the rest.
        </p>

        <SendAssistant />

        {ownedFiles.length > 0 && (
          <div className="card">
            <div className="card-head"><h2>Or open one you already sent</h2></div>
            {ownedFiles.slice(0, 12).map((f) => (
              <Link key={f.loanFileId} to={`/portal/file/${f.loanFileId}/application`} className="row linkcard">
                <div className="spread">
                  <div className="rlabel">{f.borrowerName || 'Unnamed borrower'}</div>
                  <span className="btn btn-sm">Review →</span>
                </div>
              </Link>
            ))}
            {ownedFiles.length > 12 && (
              <p className="hint"><Link to="/portal">See all {ownedFiles.length} files →</Link></p>
            )}
          </div>
        )}
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

      {/* An account with no grants and no files is ambiguous: it is a borrower whose link never
          redeemed, or it is a broker on their first day, and the page cannot tell which. Guessing
          borrower is how the owner of this system ended up being told to contact his loan officer.
          Both doors, second one plainly labelled, is better than picking wrong. */}
      <div style={{ marginTop: 28 }}>
        <h2 style={{ marginBottom: 6 }}>Sending one instead?</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          If you’re the loan officer and it’s the borrower who needs the application, this makes
          their file and their link together.
        </p>
        <SendAssistant />
      </div>
    </div>
  )
}
