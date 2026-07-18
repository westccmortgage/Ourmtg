// Public front door only. OurMtg is an operating workspace, not another mortgage
// marketing site; product/program education remains on WCCM's public sites.
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/config'
import { useAuth } from '../lib/auth'

export default function Home() {
  const { user } = useAuth()
  return (
    <>
      <section className="gateway-hero">
        <div className="gateway-status"><span>●</span> Secure mortgage workspace</div>
        <p className="eyebrow">{BRAND.company} · NMLS #{BRAND.nmlsCompany}</p>
        <h1>Your mortgage file.<br /><span>Organized around the next decision.</span></h1>
        <p className="lead">A private workspace for borrowers and the mortgage team to collect documents, review income, track conditions, and move each file forward.</p>
        <div className="cta-grid">
          <Link to={user ? '/portal' : '/login'} className="btn btn-primary btn-lg">{user ? 'Open workspace' : 'Sign in securely'}</Link>
          <Link to="/plan" className="btn btn-ghost btn-lg">Start a file</Link>
        </div>
      </section>

      <section className="gateway-grid">
        <div>
          <span className="gateway-number">01</span>
          <h2>Borrower</h2>
          <p>Upload requested documents, see what is next, and receive only information your mortgage team has reviewed.</p>
          <Link to="/login">Open borrower portal →</Link>
        </div>
        <div>
          <span className="gateway-number">02</span>
          <h2>Loan team</h2>
          <p>Operate the pipeline, review documents and statement income, clear conditions, and make the human decision.</p>
          <Link to="/login">Open operating desk →</Link>
        </div>
        <div>
          <span className="gateway-number">03</span>
          <h2>Transaction partners</h2>
          <p>Realtors, escrow, and title receive the milestones they need without access to borrower financial documents.</p>
          <Link to="/realtor">Partner access →</Link>
        </div>
      </section>
    </>
  )
}
