// App shell: top bar (brand + sign-in/out) and the compliance footer (NMLS + EHO,
// required on every page per spec §M). Content is rendered via <Outlet/>.
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { BRAND } from '../lib/config'

export function ComplianceFooter() {
  const nmls = [
    BRAND.nmlsCompany && `Company NMLS #${BRAND.nmlsCompany}`,
    BRAND.nmlsLo && `LO NMLS #${BRAND.nmlsLo}`,
  ].filter(Boolean).join(' · ')
  return (
    <footer className="footer">
      <div className="container">
        <p className="eho">🏠 Equal Housing Opportunity · {BRAND.company}</p>
        {nmls && <p>{nmls}</p>}
        <p>
          Office: <a href={`tel:${BRAND.officePhone}`}>{BRAND.officePhone}</a>
          {BRAND.loPhone && <> · {BRAND.loName || 'Direct'}: <a href={`tel:${BRAND.loPhone}`}>{BRAND.loPhone}</a></>}
          {BRAND.email && <> · <a href={`mailto:${BRAND.email}`}>{BRAND.email}</a></>}
        </p>
        <p>
          <Link to="/legal/privacy">Privacy Policy</Link> · <Link to="/legal/terms">Terms of Use</Link>
        </p>
        <p>
          A {BRAND.company} company · Investing in real-estate-secured notes?{' '}
          <a href="https://privatenotecapital.com" target="_blank" rel="noopener">Private Note Capital →</a>
        </p>
        <p className="disc">
          This is not a commitment to lend. All figures are estimates and subject to change.
          Program availability, funding, and eligibility change and are subject to program guidelines.
        </p>
      </div>
    </footer>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="app">
      <header className="topbar">
        <div className="container">
          <Link to="/" className="brand">our<span>mtg</span></Link>
          <nav className="topbar-actions">
            {user ? (
              <>
                <NavLink to="/portal" end>{({ isActive }) => isActive ? '● My portal' : 'My portal'}</NavLink>
                <button className="linkbtn" onClick={async () => { await signOut(); navigate('/') }}>Sign out</button>
              </>
            ) : (
              <Link to="/login">Sign in</Link>
            )}
          </nav>
        </div>
      </header>
      <main className="main">
        <div className="container">
          <Outlet />
        </div>
      </main>
      <ComplianceFooter />
    </div>
  )
}
