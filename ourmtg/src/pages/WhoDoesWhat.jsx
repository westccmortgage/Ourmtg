// «Who sends what» — the confusion killer. First-time buyers can't tell realtor
// paperwork from lender paperwork ("why did YOU send me this form?" — "that wasn't
// me, that was your inspector"). This page is the cast of the whole transaction:
// every player, what they send you, and what they never send. Public, linked from
// the borrower portal and the file builder.
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/config'

const CAST = [
  {
    who: 'Your loan team (us)', chip: 'us', accent: true,
    sends: 'The document checklist in this portal, your pre-approval letter, the Loan Estimate, and near closing — the Closing Disclosure.',
    never: 'We never send home-inspection forms or property disclosures — that’s the realtor side.',
  },
  {
    who: 'Your realtor', chip: 'realtor',
    sends: 'The purchase agreement, seller disclosure packets, and inspection scheduling. Lots of signatures — that’s normal.',
    never: 'They never ask for your bank statements or pay stubs. Financials come only to us, through this portal.',
  },
  {
    who: 'Home inspector', chip: 'inspector',
    sends: 'One big inspection report after visiting the house. It’s advice, not homework — nothing to fill out.',
    never: 'Nothing to sign for the loan. The report is for YOUR decision, not for the lender.',
  },
  {
    who: 'Appraiser', chip: 'appraiser',
    sends: 'Nothing to you. They value the home for the lender; you just see the result inside your file.',
    never: 'An appraiser will never call you for documents or money.',
  },
  {
    who: 'Escrow / Title', chip: 'escrow',
    sends: 'Wiring instructions for your down payment and the settlement statement. Title sends a preliminary title report.',
    never: '⚠️ Wire fraud is real: ALWAYS confirm wiring instructions by phone using a number you already know — never one from the email itself.',
  },
  {
    who: 'Insurance agent', chip: 'insurance',
    sends: 'Your homeowners policy quote and declaration page. You choose the agent — we just need the proof.',
    never: 'They don’t need your loan documents — only the property details.',
  },
]

export default function WhoDoesWhat() {
  return (
    <div style={{ maxWidth: 620, margin: '8px auto' }}>
      <Link to="/" className="backlink">← Home</Link>
      <section className="hero" style={{ padding: '12px 0 4px' }}>
        <p className="eyebrow">the cast of your transaction</p>
        <h1>who sends what<br /><span className="lt">(and who never does).</span></h1>
        <p className="lead">
          Buying a home means forms from six different people, and nobody tells you
          which is which. Here’s the whole cast — so no envelope ever confuses you again.
        </p>
        <div className="wire" aria-hidden="true" style={{ margin: '22px 0 0' }} />
      </section>

      <div style={{ marginTop: 24 }}>
        {CAST.map((c) => (
          <div className="card" key={c.who}>
            <div className="card-head">
              <h2>{c.who}</h2>
              <span className={`chip ${c.accent ? '' : 'gray'}`}>{c.chip}</span>
            </div>
            <div className="row">
              <div className="grow">
                <div className="rlabel">Sends you</div>
                <div className="rsub">{c.sends}</div>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <div className="rlabel">{c.never.startsWith('⚠️') ? 'Watch out' : 'Never sends'}</div>
                <div className="rsub">{c.never}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head"><h2>The golden rule</h2></div>
        <p className="mb0">
          Confused by any form, from anyone? Forward it to us — {BRAND.email && <a href={`mailto:${BRAND.email}`}>{BRAND.email}</a>} or
          text {BRAND.loPhone && <a href={`tel:${BRAND.loPhone}`}>{BRAND.loPhone}</a>} — and we’ll tell you in one line
          who sent it, why, and whether it can wait. Decoding paperwork is part of the service, not a favor.
        </p>
      </div>

      <div className="cta-grid" style={{ marginBottom: 24 }}>
        <Link to="/plan" className="btn btn-primary btn-lg">Build my file — 60 sec</Link>
        <Link to="/login" className="btn btn-ghost btn-lg">Open my portal</Link>
      </div>
    </div>
  )
}
