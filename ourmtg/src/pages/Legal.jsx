// Minimal Privacy / Terms surface (spec §M requires these to exist and be linked from the
// footer). Placeholder legal copy — replace with counsel-approved text before launch. The
// canonical policies mirror GRCRM's /legal/privacy and /legal/terms.
import { Link, useParams } from 'react-router-dom'
import { BRAND } from '../lib/config'

const COPY = {
  privacy: {
    title: 'Privacy Policy',
    body: [
      `${BRAND.company} collects the information you provide (name, contact details, and loan-related information) to process your mortgage inquiry and loan file.`,
      'Financial documents you upload are stored in a private, encrypted bucket and are accessible only to your loan team via short-lived, access-controlled links. We never store your documents in any public location.',
      'We do not sell your personal information. We share it only with service providers and investors as needed to process your loan, and as required by law.',
      'You can request access to or deletion of your data at any time by contacting your loan officer.',
    ],
  },
  terms: {
    title: 'Terms of Use',
    body: [
      `This portal is provided by ${BRAND.company} to help you apply for and track a mortgage loan.`,
      'Nothing in this portal is a commitment to lend or an approval. All figures shown are estimates and subject to change based on program guidelines, underwriting, and market conditions.',
      'By using this portal you agree to receive electronic communications and documents (E-SIGN / ESIGN consent). You may withdraw consent by contacting your loan officer.',
      'Program availability, funding, and eligibility change and are subject to program guidelines. Equal Housing Opportunity.',
    ],
  },
}

export default function Legal() {
  const { doc } = useParams()
  const c = COPY[doc] || COPY.privacy
  return (
    <div style={{ maxWidth: 640, margin: '8px auto' }}>
      <Link to="/" className="backlink">← Home</Link>
      <h1>{c.title}</h1>
      {c.body.map((p, i) => <p key={i}>{p}</p>)}
      <p className="disc">This is placeholder text pending final legal review. Contact {BRAND.company} for the current policy.</p>
    </div>
  )
}
