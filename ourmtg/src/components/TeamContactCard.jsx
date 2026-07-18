// Phase 1B — verified mortgage-team contact + licensing card (§7F). Static compliance facts.
import { TEAM } from '../lib/config'

export default function TeamContactCard() {
  return (
    <div className="card">
      <div className="card-head"><h2>Your mortgage team</h2></div>
      <div className="row">
        <div className="grow">
          <div className="rlabel">{TEAM.company}</div>
          <div className="rsub">
            Office <a href={`tel:${TEAM.officePhone}`}>{TEAM.officePhone}</a> ·
            Direct <a href={`tel:${TEAM.directPhone}`}>{TEAM.directPhone}</a><br />
            <a href={`mailto:${TEAM.email}`}>{TEAM.email}</a>
          </div>
        </div>
        <a className="btn btn-primary btn-sm" href={`tel:${TEAM.directPhone}`}>Call</a>
      </div>
      <div className="row">
        <div className="grow">
          <div className="rlabel">{TEAM.officer.name}</div>
          <div className="rsub">
            {TEAM.officer.title} · CA DRE #{TEAM.officer.dreLicense} · NMLS #{TEAM.officer.nmls}
          </div>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        {TEAM.company} · CA DRE Corporation #{TEAM.corporation.dreLicense} · NMLS #{TEAM.corporation.nmls} ·
        Equal Housing Opportunity
      </p>
    </div>
  )
}
