// Home = the 2-button front door (spec §K.1), merged-concept edition: quiet paper,
// one oversized lowercase headline, the wire with its traveling dot, and a ledger of
// three plain promises. No marketing fluff — the restraint IS the brand. Trilingual
// (EN / ES / RU): the owner-editable hero copy comes from site settings; the rest of
// the fixed chrome resolves through the UI dictionary.
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/config'
import { useSettings } from '../lib/useSettings'
import { useT } from '../lib/i18n'

export default function Home() {
  const { home } = useSettings()
  const t = useT()
  return (
    <>
      <section className="hero">
        <p className="eyebrow">{BRAND.company} · NMLS #{BRAND.nmlsCompany} · California</p>
        <h1>{home.headline}<br /><span className="lt">{home.headlineAlt}</span></h1>
        <p className="lead">{home.sub}</p>
        <div className="cta-grid">
          <Link to="/plan" className="btn btn-primary btn-lg">{t('homeCtaBuild')}</Link>
          <Link to="/realtor" className="btn btn-ghost btn-lg">{t('homeCtaRealtor')}</Link>
        </div>
        <p style={{ marginTop: 18 }}>
          <small>{t('homeNoQ')} <Link to="/apply">{t('homeStartApp')}</Link>. {t('homeHavePortal')} <Link to="/login">{t('signIn')}</Link>.</small>
        </p>
        <div className="wire" aria-hidden="true" />
      </section>

      <div className="card" style={{ marginTop: 28 }}>
        <div className="row">
          <span className="chip gray">{t('chipDocs')}</span>
          <div className="grow">
            <div className="rlabel">{t('homeDocsT')}</div>
            <div className="rsub">{t('homeDocsS')}</div>
          </div>
        </div>
        <div className="row">
          <span className="chip gray">{t('chipStatus')}</span>
          <div className="grow">
            <div className="rlabel">{t('homeStatusT')}</div>
            <div className="rsub">{t('homeStatusS')}</div>
          </div>
        </div>
        <div className="row">
          <span className="chip gray">{t('chipPrivate')}</span>
          <div className="grow">
            <div className="rlabel">{t('homePrivateT')}</div>
            <div className="rsub">{t('homePrivateS')}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>{t('findYourPath')}</h2></div>
        <div className="row"><div className="grow"><Link to="/dpa" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathDpa')}</Link><div className="rsub">{t('pathDpaS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/fha" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathFha')}</Link><div className="rsub">{t('pathFhaS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/va" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathVa')}</Link><div className="rsub">{t('pathVaS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/self-employed" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathSelf')}</Link><div className="rsub">{t('pathSelfS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/jumbo" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathJumbo')}</Link><div className="rsub">{t('pathJumboS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/refi" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathRefi')}</Link><div className="rsub">{t('pathRefiS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/calculator" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathCalc')}</Link><div className="rsub">{t('pathCalcS')}</div></div></div>
        <div className="row"><div className="grow"><Link to="/who" className="rlabel" style={{ textDecoration: 'none' }}>{t('pathWho')}</Link><div className="rsub">{t('pathWhoS')}</div></div></div>
      </div>
    </>
  )
}
