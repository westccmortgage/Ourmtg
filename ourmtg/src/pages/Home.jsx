// Home = the 2-button front door (spec §K.1). NOT a marketing page: one value prop and
// two clear paths — start an application (borrower) or refer a buyer (realtor) — plus a
// one-tap sign-in for people who already have a portal.
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/config'

export default function Home() {
  return (
    <>
      <section className="hero">
        <h1>Your loan, moving forward.</h1>
        <p className="lead">
          One secure link with {BRAND.company}. Start your application, upload documents from
          your phone, and always know exactly what’s next — no phone tag, no paperwork chase.
        </p>
        <div className="cta-grid">
          <Link to="/apply" className="btn btn-primary btn-lg btn-block">Start your application</Link>
          <Link to="/realtor" className="btn btn-navy btn-lg btn-block">I’m a Realtor</Link>
        </div>
        <p style={{ marginTop: 22 }}>
          <small>Already have a portal? <Link to="/login">Sign in with your email</Link>.</small>
        </p>
      </section>

      <div className="card">
        <div className="row">
          <div className="grow">
            <div className="rlabel">📄 Documents that collect themselves</div>
            <div className="rsub">A clear checklist and secure upload — snap a photo, done.</div>
          </div>
        </div>
        <div className="row">
          <div className="grow">
            <div className="rlabel">📍 Status without texting anyone</div>
            <div className="rsub">A live 7-step tracker shows exactly where your loan stands.</div>
          </div>
        </div>
        <div className="row">
          <div className="grow">
            <div className="rlabel">🔒 Bank-level security</div>
            <div className="rsub">Financial documents stay private — encrypted, never public.</div>
          </div>
        </div>
      </div>
    </>
  )
}
