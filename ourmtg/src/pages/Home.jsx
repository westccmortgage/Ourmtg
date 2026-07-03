// Home = the 2-button front door (spec §K.1), merged-concept edition: quiet paper,
// one oversized lowercase headline, the wire with its traveling dot, and a ledger of
// three plain promises. No marketing fluff — the restraint IS the brand.
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/config'

export default function Home() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">{BRAND.company} · NMLS #{BRAND.nmlsCompany} · California</p>
        <h1>the mortgage,<br /><span className="lt">minus the noise.</span></h1>
        <p className="lead">
          One secure link: upload documents from your phone, watch your loan move
          stage by stage, and always know what’s next — without a single
          “just checking in” call.
        </p>
        <div className="cta-grid">
          <Link to="/apply" className="btn btn-primary btn-lg">Start your application</Link>
          <Link to="/realtor" className="btn btn-ghost btn-lg">I’m a Realtor</Link>
        </div>
        <p style={{ marginTop: 18 }}>
          <small>Already have a portal? <Link to="/login">Sign in</Link>.</small>
        </p>
        <div className="wire" aria-hidden="true" />
      </section>

      <div className="card" style={{ marginTop: 28 }}>
        <div className="row">
          <span className="chip gray">docs</span>
          <div className="grow">
            <div className="rlabel">Documents that collect themselves</div>
            <div className="rsub">A checklist for your exact loan type. Snap a photo — filed, encrypted, done.</div>
          </div>
        </div>
        <div className="row">
          <span className="chip gray">status</span>
          <div className="grow">
            <div className="rlabel">Status without texting anyone</div>
            <div className="rsub">Seven stages, one moving dot. You’ll know before you think to ask.</div>
          </div>
        </div>
        <div className="row">
          <span className="chip gray">private</span>
          <div className="grow">
            <div className="rlabel">Your file stays yours</div>
            <div className="rsub">Financial documents live in a private vault — never public, never emailed around.</div>
          </div>
        </div>
      </div>
    </>
  )
}
