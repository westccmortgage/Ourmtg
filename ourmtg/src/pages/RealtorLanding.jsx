// Public realtor front door (spec §K.7 entry). Explains the partnership in one breath,
// lets a realtor submit a buyer immediately, and points existing partners to sign in to
// track their referred buyers (milestone-only, zero financials).
import { Link } from 'react-router-dom'
import SubmitBuyerForm from '../components/SubmitBuyerForm'

export default function RealtorLanding() {
  return (
    <div style={{ maxWidth: 560, margin: '8px auto' }}>
      <Link to="/" className="backlink">← Home</Link>
      <h1>For Realtors</h1>
      <p className="muted">
        Refer a buyer in 30 seconds and get automatic milestone updates — pre-approved, in
        processing, clear to close, funded — without ever seeing (or handling) their financials.
      </p>

      <div className="card">
        <div className="card-head"><h2>Submit a buyer</h2></div>
        <SubmitBuyerForm />
      </div>

      <div className="card">
        <h2>Already a partner?</h2>
        <p className="mb0 muted">Sign in to track every referred buyer’s milestone and grab your co-branded link and open-house QR code.</p>
        <div style={{ marginTop: 12 }}>
          <Link to="/login" className="btn btn-ghost">Sign in to your realtor portal</Link>
        </div>
      </div>
    </div>
  )
}
