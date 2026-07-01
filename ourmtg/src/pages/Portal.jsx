// Authenticated dispatcher. Detects the user's role(s) and renders the matching home:
// borrower dashboard, realtor portal, or LO dashboard. If more than one applies (rare),
// a small switcher lets the user change view via ?as=. New users with no access yet get
// a friendly "waiting on your invite" screen.
import { useSearchParams } from 'react-router-dom'
import { useRole } from '../lib/useRole'
import { Alert, Spinner } from '../components/ui'
import BorrowerDashboard from './BorrowerDashboard'
import RealtorPortal from './RealtorPortal'
import LODashboard from './LODashboard'

const ROLE_LABEL = { borrower: 'My loan', realtor: 'Partner portal', lo: 'Loan team' }

export default function Portal() {
  const { loading, error, roles, grants, ownedFiles } = useRole()
  const [params, setParams] = useSearchParams()

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>

  if (roles.length === 0) {
    return (
      <div style={{ maxWidth: 480, margin: '24px auto' }}>
        <div className="card center">
          <h1>You’re signed in 👋</h1>
          <p>Your loan portal isn’t linked to a file yet. Your loan officer will send you a secure
            invite link — open it from your email to see your status and upload documents.</p>
          <p className="muted mb0">If you were expecting access, ask your loan officer to resend your invite.</p>
        </div>
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
      {active === 'borrower' && <BorrowerDashboard grants={grants.filter((g) => g.visibility === 'borrower' || g.visibility === 'coborrower')} />}
      {active === 'realtor' && <RealtorPortal grants={grants.filter((g) => ['realtor', 'escrow', 'title'].includes(g.visibility))} />}
      {active === 'lo' && <LODashboard files={ownedFiles} />}
    </>
  )
}
