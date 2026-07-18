import { Link } from 'react-router-dom'

export default function InternalWorkspace({ children }) {
  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div>
          <p className="workspace-kicker">West Coast Capital Mortgage</p>
          <div className="workspace-brand">OurMtg <span>Desk</span></div>
        </div>
        <nav className="workspace-nav" aria-label="Loan team workspace">
          <a href="#overview"><span>01</span>Overview</a>
          <a href="#pipeline"><span>02</span>Loan pipeline</a>
          <a href="#review"><span>03</span>Review queue</a>
          <a href="#team"><span>04</span>Team & access</a>
          <a href="#settings"><span>05</span>Settings</a>
        </nav>
        <Link to="/portal/new-file" className="btn workspace-new-file">+ New loan file</Link>
        <div className="workspace-rule">
          <strong>Human decision boundary</strong>
          <span>Automation prepares the file. Licensed people confirm income and issue pre-approvals.</span>
        </div>
      </aside>
      <section className="workspace-content">
        <div className="workspace-topline">
          <span>Mortgage operations</span>
          <span className="workspace-secure">● Secure internal workspace</span>
        </div>
        {children}
      </section>
    </div>
  )
}
