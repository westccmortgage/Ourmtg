import { useEffect, useMemo, useState } from 'react'
import {
  getStatementAnalysis,
  createStatementAnalysis,
  saveStatementAnalysis,
  reviewStatementAnalysis,
} from '../lib/api'
import { money, shortDate } from '../lib/format'
import { Alert, Empty, Spinner } from './ui'

export function BorrowerStatementIncome({ loanFileId }) {
  const [state, setState] = useState({ loading: true, analysis: null })
  useEffect(() => {
    let alive = true
    getStatementAnalysis(loanFileId)
      .then((result) => { if (alive) setState({ loading: false, analysis: result.analysis }) })
      .catch(() => { if (alive) setState({ loading: false, analysis: null }) })
    return () => { alive = false }
  }, [loanFileId])
  if (state.loading || !state.analysis?.borrowerVisible) return null
  const analysis = state.analysis
  return (
    <div className="card reviewed-income-card">
      <div className="card-head">
        <h2>Reviewed statement income</h2>
        <span className="chip green">Human reviewed</span>
      </div>
      <div className="reviewed-income-number">{money(analysis.reviewedMonthlyIncome)}<small>/month</small></div>
      <p className="muted mb0">
        Based on {analysis.periodMonths} months of {analysis.statementType} bank statements and reviewed by your mortgage team
        {analysis.reviewedAt ? ` on ${shortDate(analysis.reviewedAt)}` : ''}.
      </p>
      <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
        This is a reviewed income analysis, not a loan approval or commitment to lend. Your loan officer considers credit, assets, debts, property, and lender guidelines before issuing a conditional pre-approval.
      </p>
    </div>
  )
}

export default function StatementIncomePanel({ loanFileId, documents = [] }) {
  const [analysis, setAnalysis] = useState(null)
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [statementType, setStatementType] = useState('business')
  const [periodMonths, setPeriodMonths] = useState(12)
  const [expenseFactorPct, setExpenseFactorPct] = useState(50)
  const [ownershipPct, setOwnershipPct] = useState(100)
  const [selected, setSelected] = useState([])
  const [months, setMonths] = useState([])
  const [reviewedIncome, setReviewedIncome] = useState('')
  const [reviewerNotes, setReviewerNotes] = useState('')

  const candidates = useMemo(() => documents.filter((doc) =>
    ['uploaded', 'accepted'].includes(doc.status)
      && /bank|statement/i.test(`${doc.docKey || ''} ${doc.label || ''}`)), [documents])

  async function load() {
    const result = await getStatementAnalysis(loanFileId)
    setAvailable(result.available !== false)
    setAnalysis(result.analysis || null)
    if (result.analysis) {
      setStatementType(result.analysis.statementType)
      setPeriodMonths(result.analysis.periodMonths)
      setExpenseFactorPct(result.analysis.expenseFactorPct)
      setOwnershipPct(result.analysis.ownershipPct)
      setMonths(result.analysis.months || [])
      setReviewedIncome(result.analysis.reviewedMonthlyIncome ?? result.analysis.calculatedMonthlyIncome ?? '')
      setReviewerNotes(result.analysis.reviewerNotes || '')
    }
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    getStatementAnalysis(loanFileId)
      .then((result) => {
        if (!alive) return
        setAvailable(result.available !== false)
        setAnalysis(result.analysis || null)
        if (result.analysis) {
          setStatementType(result.analysis.statementType)
          setPeriodMonths(result.analysis.periodMonths)
          setExpenseFactorPct(result.analysis.expenseFactorPct)
          setOwnershipPct(result.analysis.ownershipPct)
          setMonths(result.analysis.months || [])
          setReviewedIncome(result.analysis.reviewedMonthlyIncome ?? result.analysis.calculatedMonthlyIncome ?? '')
          setReviewerNotes(result.analysis.reviewerNotes || '')
        }
      })
      .catch((err) => { if (alive) setError(err?.message || 'Could not load statement analysis.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [loanFileId])

  useEffect(() => {
    if (!analysis && candidates.length) setSelected(candidates.map((doc) => doc.id))
  }, [analysis, candidates])

  function toggleDocument(id) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  async function create() {
    setBusy(true); setError(''); setMessage('')
    try {
      await createStatementAnalysis({
        loanFileId,
        documentIds: selected,
        statementType,
        periodMonths,
        expenseFactorPct,
        ownershipPct,
      })
      await load()
      setMessage('Statements extracted. Review every month before confirming income.')
    } catch (err) { setError(err?.message || 'Could not analyze statements.') }
    finally { setBusy(false) }
  }

  function editMonth(index, field, value) {
    setMonths((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  }

  async function saveWorksheet() {
    setBusy(true); setError(''); setMessage('')
    try {
      await saveStatementAnalysis({
        analysisId: analysis.id,
        expenseFactorPct,
        ownershipPct,
        months: months.map((row) => ({
          id: row.id,
          statementMonth: row.statementMonth ? `${String(row.statementMonth).slice(0, 7)}-01` : null,
          totalDeposits: row.totalDeposits,
          excludedDeposits: row.excludedDeposits || 0,
          reviewerNote: row.reviewerNote || null,
        })),
      })
      await load()
      setMessage('Worksheet saved and recalculated. No pre-approval was issued.')
    } catch (err) { setError(err?.message || 'Could not save the worksheet.') }
    finally { setBusy(false) }
  }

  async function confirmReview() {
    setBusy(true); setError(''); setMessage('')
    try {
      await reviewStatementAnalysis({
        analysisId: analysis.id,
        reviewedMonthlyIncome: reviewedIncome,
        reviewerNotes,
      })
      await load()
      setMessage('Income analysis confirmed and shared with the borrower. Pre-approval remains a separate human action.')
    } catch (err) { setError(err?.message || 'Could not confirm the reviewed income.') }
    finally { setBusy(false) }
  }

  if (loading) return <div className="card"><Spinner /></div>
  if (!available) {
    return <div className="card"><div className="card-head"><h2>Statement Income Analysis</h2><span className="chip gray">Database setup required</span></div><p className="muted mb0">Apply the prepared statement-analysis database delta before using this workspace.</p></div>
  }

  return (
    <div className="card statement-panel">
      <div className="card-head">
        <div>
          <p className="workspace-kicker">Income desk</p>
          <h2>Statement Income Analysis</h2>
        </div>
        <span className={`chip ${analysis?.status === 'reviewed' ? 'green' : 'amber'}`}>{analysis?.status === 'reviewed' ? 'Human reviewed' : 'Review required'}</span>
      </div>
      <p className="muted mt0">Digital PDFs are read automatically. Extracted deposits are suggestions until a loan-team user verifies every month. This workflow never issues a pre-approval automatically.</p>
      <Alert kind="error">{error}</Alert>
      {message && <Alert kind="ok">{message}</Alert>}

      {!analysis && (
        <>
          {candidates.length === 0 && <Empty>Upload or accept a bank-statement document first.</Empty>}
          {candidates.map((doc) => (
            <label className="statement-doc-choice" key={doc.id}>
              <input type="checkbox" checked={selected.includes(doc.id)} onChange={() => toggleDocument(doc.id)} />
              <span><strong>{doc.label}</strong><small>{doc.status}</small></span>
            </label>
          ))}
          <div className="grid4" style={{ marginTop: 16 }}>
            <div className="field"><label>Statement type</label><select value={statementType} onChange={(event) => setStatementType(event.target.value)}><option value="business">Business</option><option value="personal">Personal</option></select></div>
            <div className="field"><label>Period</label><select value={periodMonths} onChange={(event) => setPeriodMonths(Number(event.target.value))}><option value={12}>12 months</option><option value={24}>24 months</option></select></div>
            <div className="field"><label>Expense factor %</label><input type="number" min="0" max="100" value={statementType === 'business' ? expenseFactorPct : 0} disabled={statementType !== 'business'} onChange={(event) => setExpenseFactorPct(event.target.value)} /></div>
            <div className="field"><label>Ownership %</label><input type="number" min="0" max="100" value={statementType === 'business' ? ownershipPct : 100} disabled={statementType !== 'business'} onChange={(event) => setOwnershipPct(event.target.value)} /></div>
          </div>
          <button className="btn btn-primary btn-sm" disabled={busy || !selected.length} onClick={create}>{busy ? 'Analyzing…' : 'Analyze selected statements'}</button>
        </>
      )}

      {analysis && (
        <>
          <div className="analysis-metrics">
            <div><span>Extracted calculation</span><strong>{money(analysis.calculatedMonthlyIncome || 0)}<small>/mo</small></strong></div>
            <div><span>Months found</span><strong>{analysis.calculation?.monthsCovered || 0}<small>of {analysis.periodMonths}</small></strong></div>
            <div><span>Eligible deposits</span><strong>{money(analysis.calculation?.eligibleDeposits || 0)}</strong></div>
            <div><span>Trend</span><strong className={analysis.calculation?.decliningTrend ? 'danger-text' : ''}>{analysis.calculation?.trendPct == null ? '—' : `${analysis.calculation.trendPct}%`}</strong></div>
          </div>

          <div className="grid2">
            <div className="field"><label>Expense factor %</label><input type="number" min="0" max="100" disabled={statementType !== 'business'} value={statementType === 'business' ? expenseFactorPct : 0} onChange={(event) => setExpenseFactorPct(event.target.value)} /></div>
            <div className="field"><label>Borrower ownership %</label><input type="number" min="0" max="100" disabled={statementType !== 'business'} value={statementType === 'business' ? ownershipPct : 100} onChange={(event) => setOwnershipPct(event.target.value)} /></div>
          </div>

          <div className="tablewrap statement-table-wrap">
            <table className="q statement-table">
              <thead><tr><th>Month</th><th>Total deposits</th><th>Excluded</th><th>Source / review note</th></tr></thead>
              <tbody>
                {months.map((row, index) => (
                  <tr key={row.id}>
                    <td><input aria-label={`Statement month ${index + 1}`} type="month" value={row.statementMonth ? String(row.statementMonth).slice(0, 7) : ''} onChange={(event) => editMonth(index, 'statementMonth', event.target.value)} /></td>
                    <td><input aria-label={`Total deposits ${index + 1}`} type="number" min="0" step="0.01" value={row.totalDeposits ?? ''} onChange={(event) => editMonth(index, 'totalDeposits', event.target.value)} /></td>
                    <td><input aria-label={`Excluded deposits ${index + 1}`} type="number" min="0" step="0.01" value={row.excludedDeposits ?? 0} onChange={(event) => editMonth(index, 'excludedDeposits', event.target.value)} /></td>
                    <td><input aria-label={`Review note ${index + 1}`} value={row.reviewerNote || ''} placeholder={row.extractionStatus === 'extracted' ? row.accountLabel || 'Verified' : 'Manual entry required'} onChange={(event) => editMonth(index, 'reviewerNote', event.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pill-row" style={{ marginTop: 14 }}><button className="btn btn-navy btn-sm" disabled={busy} onClick={saveWorksheet}>{busy ? 'Saving…' : 'Save verified worksheet'}</button></div>

          <div className="human-review-box">
            <div className="card-head"><h2>Human review decision</h2><span className="chip gray">Not a pre-approval</span></div>
            <div className="field"><label>Reviewed qualifying monthly income</label><input type="number" min="0" step="0.01" value={reviewedIncome} onChange={(event) => setReviewedIncome(event.target.value)} /></div>
            <div className="field"><label>Internal review notes</label><textarea value={reviewerNotes} onChange={(event) => setReviewerNotes(event.target.value)} placeholder="Explain overrides, unusual deposits, trend, or lender-specific treatment." /></div>
            <button className="btn btn-primary btn-sm" disabled={busy || !analysis.calculation?.readyForHumanReview || analysis.calculation?.reviewRequired > 0 || !reviewedIncome} onClick={confirmReview}>{busy ? 'Confirming…' : 'Confirm reviewed income'}</button>
            {!analysis.calculation?.readyForHumanReview && <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>Complete all {analysis.periodMonths} statement months before confirming.</p>}
          </div>
        </>
      )}
    </div>
  )
}
