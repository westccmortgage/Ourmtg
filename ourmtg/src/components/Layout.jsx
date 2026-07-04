// App shell: top bar (brand + sign-in/out) and the compliance footer (NMLS + EHO,
// required on every page per spec §M). Content is rendered via <Outlet/>.
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { BRAND } from '../lib/config'
import { useT, LangSwitch } from '../lib/i18n'

export function ComplianceFooter() {
  const t = useT()
  const nmls = [
    BRAND.nmlsCompany && `Company NMLS #${BRAND.nmlsCompany}`,
    BRAND.nmlsLo && `LO NMLS #${BRAND.nmlsLo}`,
  ].filter(Boolean).join(' · ')
  return (
    <footer className="footer">
      <div className="container">
        <p className="eho">🏠 {t('footerEho')} · {BRAND.company}</p>
        {nmls && <p>{nmls}</p>}
        <p>
          Office: <a href={`tel:${BRAND.officePhone}`}>{BRAND.officePhone}</a>
          {BRAND.loPhone && <> · {BRAND.loName || 'Direct'}: <a href={`tel:${BRAND.loPhone}`}>{BRAND.loPhone}</a></>}
          {BRAND.email && <> · <a href={`mailto:${BRAND.email}`}>{BRAND.email}</a></>}
        </p>
        <p>
          <Link to="/legal/privacy">{t('footerPrivacy')}</Link> · <Link to="/legal/terms">{t('footerTerms')}</Link>
        </p>
        <p>
          A {BRAND.company} company · {t('footerInvest')}{' '}
          <a href="https://privatenotecapital.com" target="_blank" rel="noopener">Private Note Capital →</a>
        </p>
        <p className="disc">{t('footerDisc')}</p>
      </div>
    </footer>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const t = useT()
  return (
    <div className="app">
      <header className="topbar">
        <div className="container">
          <Link to="/" className="brand">our<span>mtg</span></Link>
          <nav className="topbar-actions">
            <LangSwitch />
            {user ? (
              <>
                <NavLink to="/portal" end>{({ isActive }) => isActive ? `● ${t('myPortal')}` : t('myPortal')}</NavLink>
                <button className="linkbtn" onClick={async () => { await signOut(); navigate('/') }}>{t('signOut')}</button>
              </>
            ) : (
              <Link to="/login">{t('signIn')}</Link>
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
