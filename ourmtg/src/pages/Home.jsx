// Public front door only. OurMtg is an operating workspace, not another mortgage
// marketing site; product/program education remains on WCCM's public sites.
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/config'
import { useAuth } from '../lib/auth'

export default function Home() {
  const { user } = useAuth()
  return (
    <section className="gateway-hero">
      <div className="gateway-status"><span>●</span> Private mortgage workspace</div>
      <p className="eyebrow">{BRAND.company} · NMLS #{BRAND.nmlsCompany}</p>
      <h1>{user ? 'Your workspace is ready.' : 'Continue your mortgage file.'}<br />
        <span>One guided step at a time.</span>
      </h1>
      <p className="lead">
        {user
          ? 'Open your file to continue the application, upload requested documents, or see exactly what remains.'
          : 'Use the secure link from your mortgage team, or sign in with the same verified email address. OurMTG does not accept public applications.'}
      </p>
      <div className="cta-grid">
        <Link to={user ? '/portal' : '/login'} className="btn btn-primary btn-lg">
          {user ? 'Open my workspace' : 'Sign in securely'}
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 18 }}>
        Need an invitation or a different email address? Contact your mortgage team directly.
      </p>
    </section>
  )
}
