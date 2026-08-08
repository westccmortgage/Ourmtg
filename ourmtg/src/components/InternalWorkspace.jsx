import { Link } from 'react-router-dom'

export default function InternalWorkspace({ children, workspace }) {
  const identity = workspace?.identity
  const owners = workspace?.owners || []
  const workingUnder = workspace?.platformAdmin
    ? `${owners.length} admin portfolio${owners.length === 1 ? '' : 's'}`
    : owners.map((owner) => owner.email || 'Verified owner').join(', ')

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div>
          <p className="workspace-kicker">West Coast Capital Mortgage</p>
          <div className="workspace-brand">OurMtg <span>Desk</span></div>
        </div>
        <nav className="workspace-nav" aria-label="Loan team workspace">
          <a href="#overview"><span>01</span>Overview</a>
          <a href="#admins"><span>02</span>Admin portfolios</a>
          <a href="#pipeline"><span>03</span>Loan pipeline</a>
          <a href="#review"><span>04</span>Review queue</a>
          <a href="#team"><span>05</span>Team & access</a>
          <a href="#settings"><span>06</span>Settings</a>
        </nav>
        <Link to="/portal/new-file" className="btn workspace-new-file">+ New loan file</Link>
        <div className="workspace-rule">
          <strong>Human decision boundary</strong>
          <span>Automation prepares the file. Licensed people confirm income and issue pre-approvals.</span>
        </div>
      </aside>
      <section className="workspace-content">
        <div className="workspace-topline">
          <span className="workspace-identity">
            Signed in as <b>{identity?.email || 'verified account'}</b>
            {workingUnder && <small>Working under: {workingUnder}</small>}
          </span>
          <span className="workspace-secure">● Secure internal workspace</span>
        </div>
        {children}
      </section>
    </div>
  )
}
