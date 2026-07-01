// LO loan-file detail (spec §K.10 drill-in). Everything the LO does per file:
//   • review uploaded documents (view via signed URL, accept / reject with a reason)
//   • set or clear the Realtor-visible pre-approval band
//   • invite the borrower / co-borrower / realtor to their portal
//   • read the underwriting conditions and the file timeline
// All actions call owner-only gateway endpoints; the page reloads detail after each.
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getFileDetail, reviewDoc, setPreapproval, createInvite, requestDoc, setCondition } from '../lib/api'
import { money, shortDate, relTime } from '../lib/format'
import StatusTracker from '../components/StatusTracker'
import MessageThread from '../components/MessageThread'
import { Alert, Spinner, StatusChip, Empty } from '../components/ui'

function DocRow({ doc, onReview }) {
  const [busy, setBusy] = useState(false)
  async function act(decision) {
    let reason = null
    if (decision === 'rejected') {
      reason = window.prompt('Why does this document need another upload? (the borrower sees this)')
      if (!reason || reason.trim().length < 3) return
    }
    setBusy(true)
    try { await onReview(doc.id, decision, reason) } finally { setBusy(false) }
  }
  return (
    <div className="row">
      <div className="grow">
        <div className="rlabel">{doc.label}</div>
        <div className="rsub">
          <StatusChip status={doc.status} />
          {doc.uploadedAt && <span className="muted"> · uploaded {relTime(doc.uploadedAt)}</span>}
          {doc.downloadUrl && <> · <a href={doc.downloadUrl} target="_blank" rel="noreferrer">View</a></>}
        </div>
        {doc.status === 'rejected' && doc.rejectReason && (
          <div className="rsub" style={{ color: 'var(--red)', marginTop: 4 }}>Rejected: {doc.rejectReason}</div>
        )}
      </div>
      {doc.status === 'uploaded' && (
        <div style={{ flex: '0 0 auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('accepted')}>Accept</button>
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act('rejected')}>Reject</button>
        </div>
      )}
    </div>
  )
}

function PreapprovalCard({ file, onSaved }) {
  const [amount, setAmount] = useState(file.preapprovalAmount ?? '')
  const [expires, setExpires] = useState(file.preapprovalExpires ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  async function save(clear) {
    setBusy(true); setMsg(''); setError('')
    try {
      const r = await setPreapproval(file.loanFileId, clear ? null : amount, clear ? null : (expires || null))
      setMsg(clear ? 'Pre-approval cleared.' : `Pre-approval set to ${money(r.preapprovalAmount)}.`)
      if (clear) { setAmount(''); setExpires('') }
      onSaved?.()
    } catch (err) { setError(err?.message || 'Could not update pre-approval.') }
    finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Pre-approval <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>(Realtor-visible)</span></h2></div>
      <p className="muted mt0">This is the only figure a referred Realtor can see. Setting it emails any Realtor on the file.</p>
      <Alert kind="error">{error}</Alert>
      {msg && <Alert kind="ok">{msg}</Alert>}
      <div className="grid2">
        <div className="field">
          <label htmlFor="pa">Amount (USD)</label>
          <input id="pa" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="650000" />
        </div>
        <div className="field">
          <label htmlFor="pe">Expires</label>
          <input id="pe" type="date" value={expires || ''} onChange={(e) => setExpires(e.target.value)} />
        </div>
      </div>
      <div className="pill-row">
        <button className="btn btn-primary btn-sm" disabled={busy || !amount} onClick={() => save(false)}>Save pre-approval</button>
        {file.preapprovalAmount != null && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => save(true)}>Clear</button>}
      </div>
    </div>
  )
}

function InviteCard({ file }) {
  const [role, setRole] = useState('borrower')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  async function invite(e) {
    e.preventDefault()
    setBusy(true); setError(''); setResult(null)
    try {
      const r = await createInvite({ loanFileId: file.loanFileId, role, email })
      setResult(r)
      setEmail('')
    } catch (err) { setError(err?.message || 'Could not create invite.') }
    finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Invite to portal</h2></div>
      <Alert kind="error">{error}</Alert>
      {result && (
        <Alert kind="ok">
          Invite created{result.emailed ? ' and emailed' : ''}. Share this link if needed:
          <div className="field" style={{ marginTop: 8, marginBottom: 0 }}>
            <input readOnly value={result.inviteUrl} onFocus={(e) => e.target.select()} />
          </div>
        </Alert>
      )}
      <form onSubmit={invite}>
        <div className="grid2">
          <div className="field">
            <label htmlFor="ir">Role</label>
            <select id="ir" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="borrower">Borrower</option>
              <option value="coborrower">Co-borrower</option>
              <option value="realtor">Realtor</option>
              <option value="escrow">Escrow (milestones only)</option>
              <option value="title">Title (milestones only)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ie">Email</label>
            <input id="ie" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" />
          </div>
        </div>
        <button className="btn btn-navy btn-sm" disabled={busy || !email}>{busy ? 'Sending…' : 'Send invite'}</button>
      </form>
    </div>
  )
}

export default function LoanFileDetail() {
  const { loanFileId } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    return getFileDetail(loanFileId)
      .then(setData)
      .catch((err) => setError(err?.message || 'Could not load this loan file.'))
      .finally(() => setLoading(false))
  }, [loanFileId])

  useEffect(() => { load() }, [load])

  async function onReview(documentId, decision, rejectReason) {
    await reviewDoc(documentId, decision, rejectReason)
    await load()
  }

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return null
  const { file, documents, conditions, messages } = data
  const pending = documents.filter((d) => d.status === 'uploaded')

  return (
    <>
      <Link to="/portal" className="backlink">← Back to dashboard</Link>
      <div className="spread">
        <h1 className="mb0">{file.borrowerName || 'Loan file'}</h1>
        <span className="chip">{file.stageLabel}</span>
      </div>
      <p className="muted">
        {[file.loanType, file.purpose, file.loanNumber && `#${file.loanNumber}`].filter(Boolean).join(' · ')}
        {file.amount != null && ` · ${money(file.amount)}`}
      </p>

      <div className="card">
        <StatusTracker stage={file.stage} />
        {file.estCloseDate && <p className="muted center mb0" style={{ marginTop: 12 }}>Est. closing {shortDate(file.estCloseDate)}</p>}
      </div>

      <div className="card">
        <div className="card-head"><h2>Documents</h2>{pending.length > 0 && <span className="chip amber">{pending.length} to review</span>}</div>
        {documents.length === 0 && <Empty>No documents requested or uploaded yet.</Empty>}
        {documents.map((d) => <DocRow key={d.id} doc={d} onReview={onReview} />)}
        <RequestDocForm loanFileId={file.loanFileId} onCreated={load} />
      </div>

      <PreapprovalCard file={file} onSaved={load} />
      <InviteCard file={file} />

      <div className="card">
        <div className="card-head"><h2>Conditions</h2></div>
        {conditions.length === 0 && <Empty>No underwriting conditions on file.</Empty>}
        {conditions.map((c) => <ConditionRow key={c.id} loanFileId={file.loanFileId} condition={c} onChanged={load} />)}
        <AddConditionForm loanFileId={file.loanFileId} onCreated={load} />
      </div>

      <div className="card">
        <div className="card-head"><h2>Messages & timeline</h2></div>
        <MessageThread loanFileId={file.loanFileId} messages={messages} onSent={load}
          placeholder="Message the borrower…" />
      </div>
    </>
  )
}

function RequestDocForm({ loanFileId, onCreated }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await requestDoc(loanFileId, label.trim())
      setLabel('')
      await onCreated?.()
    } catch (err) { setError(err?.message || 'Could not create the request.') }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <Alert kind="error">{error}</Alert>
      <div className="spread">
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200}
            placeholder="Request another document (e.g. “Letter of explanation — March deposit”)" />
        </div>
        <button className="btn btn-navy btn-sm" disabled={busy || label.trim().length < 3}>
          {busy ? 'Requesting…' : 'Request'}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>Appears on the borrower’s checklist and emails them.</p>
    </form>
  )
}

function ConditionRow({ loanFileId, condition, onChanged }) {
  const [busy, setBusy] = useState(false)
  async function setStatus(status) {
    setBusy(true)
    try { await setCondition({ loanFileId, conditionId: condition.id, status }); await onChanged?.() }
    finally { setBusy(false) }
  }
  return (
    <div className="row">
      <div className="grow">
        <div className="rlabel">{condition.title}</div>
        {condition.detail && <div className="rsub">{condition.detail}</div>}
      </div>
      <StatusChip status={condition.status} />
      {condition.status !== 'cleared' && (
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setStatus('cleared')}>
          {busy ? '…' : 'Clear'}
        </button>
      )}
    </div>
  )
}

function AddConditionForm({ loanFileId, onCreated }) {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await setCondition({ loanFileId, title: title.trim(), detail: detail.trim() || null })
      setTitle(''); setDetail('')
      await onCreated?.()
    } catch (err) { setError(err?.message || 'Could not add the condition.') }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <Alert kind="error">{error}</Alert>
      <div className="field">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
          placeholder="New condition title (borrower-friendly wording)" />
      </div>
      <div className="field">
        <input value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000}
          placeholder="Detail (optional)" />
      </div>
      <button className="btn btn-navy btn-sm" disabled={busy || title.trim().length < 3}>
        {busy ? 'Adding…' : 'Add condition'}
      </button>
    </form>
  )
}
