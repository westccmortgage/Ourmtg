// Conversational 1003 — the loan team's view (§19), inside the existing loan-file workspace.
//
// Shows what a human needs in order to trust or challenge the collected information: what is
// unresolved, what contradicts, what is estimated or unconfirmed, where each value came from,
// and exactly why each flagged item needs review. Sensitive values are masked here too.

import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Alert } from '../../../components/ui'
import { getTeamReview, teamAction, newIdempotencyKey } from '../api'

const REASON_COPY = {
  contradiction_unresolved: 'Two different answers recorded',
  awaiting_borrower_confirmation: 'Captured but not confirmed by the borrower',
  clarification_requested: 'Clarification requested',
  value_is_estimated: 'Borrower marked this as an estimate',
  team_verification_required: 'Requires team verification',
  low_interpretation_confidence: 'Low interpretation confidence',
}

export default function ApplicationTeamReview() {
  const { loanFileId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('needs_review')

  const load = useCallback(async () => {
    try { setData(await getTeamReview(loanFileId)) } catch (e) { setError(e.message) }
  }, [loanFileId])
  useEffect(() => { load() }, [load])

  async function act(action, fieldPath, extra = {}) {
    setBusy(true); setError('')
    try {
      await teamAction({ loanFileId, action, fieldPath, ...extra, idempotencyKey: newIdempotencyKey(action) })
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return <p className="muted">Loading application…</p>

  const review = data.review
  const rows = filter === 'needs_review' ? review.needsReview : review.items

  return (
    <div className="c1003-team">
      <Link to={`/portal/file/${loanFileId}`} className="backlink">← Back to loan file</Link>
      <h1>Conversational application</h1>

      <div className="c1003-team-summary">
        <p>
          <strong>{review.percent}%</strong> collected · status <code>{review.status}</code>
        </p>
        {/* Stated on the screen so no one reads progress as an underwriting outcome. */}
        <p className="muted" style={{ fontSize: 13 }}>
          “Complete” means information collected and attested. It does not mean{' '}
          {review.notMeaning.join(', ').replace(/_/g, ' ')}.
        </p>
        <ul className="c1003-team-counts">
          <li>Unresolved required: <strong>{review.unresolvedRequired.length}</strong></li>
          <li>Contradictions: <strong>{review.conflicts.length}</strong></li>
          <li>Estimated values: <strong>{review.estimatedValues.length}</strong></li>
          <li>Unconfirmed values: <strong>{review.unconfirmedValues.length}</strong></li>
          <li>Structural gaps: <strong>{review.structural.length}</strong></li>
        </ul>
      </div>

      {/* Per-party progress, never blended into one number. */}
      <section className="c1003-team-parties">
        <h2>Parties</h2>
        {data.partyProgress.map((p) => (
          <div key={p.partyIndex} className="c1003-team-party">
            <strong>{p.role}</strong> — {p.open} open, {p.conflicts} contradictions
            {p.confusion.length > 0 && (
              <span className="muted"> · {p.confusion.length} repeated/confusing question(s)</span>
            )}
          </div>
        ))}
      </section>

      <div className="row">
        <button type="button" className={filter === 'needs_review' ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => setFilter('needs_review')}>Needs review ({review.needsReview.length})</button>
        <button type="button" className={filter === 'all' ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => setFilter('all')}>All captured ({review.items.length})</button>
      </div>

      <table className="c1003-team-table">
        <thead>
          <tr><th>Field</th><th>Value</th><th>Status</th><th>Source</th><th>Why flagged</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.path}>
              <td><span title={i.path}>{i.label}</span><br /><span className="muted">{i.section}</span></td>
              <td>
                {i.value ?? '—'}
                {i.estimated && <em className="muted"> (est.)</em>}
                {i.secure && <span className="muted"> masked</span>}
                {i.conflictValues && <div className="muted">conflict: {i.conflictValues.join(' / ')}</div>}
              </td>
              <td><code>{i.status}</code></td>
              <td>
                <code>{i.source}</code>
                {/* A derived value must never read as something the borrower said. */}
                {!i.borrowerStated && <div className="muted">not borrower-stated</div>}
                {i.confidence != null && <div className="muted">conf {i.confidence}</div>}
              </td>
              <td>
                <ul className="c1003-reasons">
                  {i.reasons.map((r) => <li key={r}>{REASON_COPY[r] || r}</li>)}
                </ul>
              </td>
              <td className="c1003-team-actions">
                <button type="button" className="linklike" disabled={busy}
                  onClick={() => act('confirm_reviewed', i.path)}>Confirm reviewed</button>
                <button type="button" className="linklike" disabled={busy}
                  onClick={() => {
                    const note = window.prompt('What should the borrower clarify?')
                    if (note) act('request_clarification', i.path, { note })
                  }}>Request clarification</button>
                {!i.secure && (
                  <button type="button" className="linklike" disabled={busy}
                    onClick={() => {
                      const value = window.prompt(`Correct ${i.label}`, i.value ?? '')
                      // A team correction appends an audited event; it never erases history.
                      if (value != null && value !== '') act('correct', i.path, { value })
                    }}>Correct</button>
                )}
                <button type="button" className="linklike" disabled={busy}
                  onClick={() => act('mark_not_applicable', i.path, { note: 'team' })}>Not applicable</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row c1003-team-footer">
        <button type="button" className="btn btn-ghost" disabled={busy}
          onClick={() => act('return_to_borrower')}>Return to borrower</button>
        <button type="button" className="btn btn-primary" disabled={busy || data.application.status !== 'borrower_attested'}
          onClick={() => act('accept_into_loan_file')}>Accept into loan file</button>
      </div>
      {data.application.status !== 'borrower_attested' && (
        <p className="muted" style={{ fontSize: 13 }}>
          The borrower must submit the application before it can be accepted into the loan file.
        </p>
      )}
    </div>
  )
}
