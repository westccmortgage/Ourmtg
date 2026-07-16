// Document checklist + secure upload (spec §K.4, §F.2). Renders the gateway checklist
// (required vs uploaded) and, per item, a camera/file upload that: mints a signed URL,
// uploads straight to the private bucket, then finalizes. Re-uploads after a rejection
// reuse the same flow. Realtors can never reach this (the gateway 403s the checklist).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getChecklist, uploadDocument } from '../lib/api'
import { shortDate } from '../lib/format'
import { Alert, Spinner, StatusChip } from '../components/ui'

function DocItem({ loanFileId, item, onDone, taskId }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onPick(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    if (file.size > 25 * 1024 * 1024) { setError('That file is over 25 MB — please upload a smaller file.'); return }
    setError(''); setBusy(true)
    try {
      await uploadDocument(loanFileId, item.docKey, file, taskId)
      onDone()
    } catch (err) {
      setError(err?.message || 'Upload failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const canUpload = ['missing', 'requested', 'rejected'].includes(item.status)
  const cta = item.status === 'rejected' ? 'Re-upload' : item.status === 'missing' || item.status === 'requested' ? 'Upload' : 'Replace'

  return (
    <div className="row">
      <div className="grow">
        <div className="rlabel">{item.label}</div>
        {item.why && <div className="rsub" style={{ marginTop: 2 }}>Why: {item.why}</div>}
        <div className="rsub">
          <StatusChip status={item.status} />
          {item.uploadedAt && item.status !== 'rejected' && <span className="muted"> · {shortDate(item.uploadedAt)}</span>}
        </div>
        {item.status === 'rejected' && item.rejectReason && (
          <div className="rsub" style={{ color: 'var(--red)', marginTop: 6 }}>Needs another: {item.rejectReason}</div>
        )}
        {error && <div className="rsub" style={{ color: 'var(--red)', marginTop: 6 }}>{error}</div>}
      </div>
      <div style={{ flex: '0 0 auto' }}>
        <input ref={inputRef} type="file" accept="image/*,application/pdf" hidden onChange={onPick} />
        <button
          className={`btn btn-sm ${canUpload ? 'btn-primary' : 'btn-ghost'}`}
          disabled={busy}
          onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : cta}
        </button>
      </div>
    </div>
  )
}

export default function Documents() {
  const { loanFileId } = useParams()
  const [params] = useSearchParams()
  const taskId = params.get('task') || null // task-pilot deep link: finalize links to this task
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setError('')
    return getChecklist(loanFileId)
      .then(setData)
      .catch((err) => setError(err?.message || 'Could not load your checklist.'))
      .finally(() => setLoading(false))
  }, [loanFileId])

  useEffect(() => { load() }, [load])

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return null

  const borrowerItems = data.items.filter((i) => i.who !== 'coborrower')
  const coItems = data.items.filter((i) => i.who === 'coborrower')

  return (
    <>
      <Link to="/portal" className="backlink">← Back to my loan</Link>
      <div className="spread">
        <h1 className="mb0">Your documents</h1>
        <span className="chip">{data.uploaded} of {data.total} done</span>
      </div>
      <p className="muted">Snap a photo or upload a file — no scanner needed. Everything is encrypted and private to your loan team.</p>
      <p className="fileno" style={{ marginBottom: 14 }}>
        Everything on this page is asked by your loan team (us). Inspection reports and
        disclosure packets come from your realtor — <Link to="/who">see who sends what</Link>.
      </p>

      <div className="card">
        <div className="card-head"><h2>Your items</h2></div>
        {borrowerItems.map((it) => (
          <DocItem key={it.docKey} loanFileId={loanFileId} item={it} onDone={load} taskId={taskId} />
        ))}
      </div>

      {coItems.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Co-borrower items</h2></div>
          {coItems.map((it) => (
            <DocItem key={it.docKey} loanFileId={loanFileId} item={it} onDone={load} taskId={taskId} />
          ))}
        </div>
      )}

      {data.remaining === 0 && <Alert kind="ok">All documents are in — nice work! Your team will review and reach out if anything else is needed.</Alert>}
    </>
  )
}
