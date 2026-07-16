// Borrower document checklist + secure upload. A task-linked route prepares the exact
// task through assigned → viewed → in_progress, renders only its required document, and
// finalizes with one persisted idempotent operation.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getChecklist, uploadDocument, getTaskDetail, transitionTask, completeUpload } from '../lib/api'
import { shortDate } from '../lib/format'
import { borrowerPreparationActions } from '../lib/taskUi'
import { getOrCreatePendingOperation, readPendingOperation, settlePendingOperation } from '../lib/pendingOps'
import { Alert, Spinner, StatusChip } from '../components/ui'

async function transitionBorrowerTask(task, action) {
  const payload = { taskId: task.id, action, expectedRevision: Number(task.revision || 0) }
  const scope = `task-transition:${task.id}:${action}`
  const op = getOrCreatePendingOperation(scope, payload)
  try {
    const result = await transitionTask(task.id, action, { ...payload, idempotencyKey: op.idempotencyKey })
    settlePendingOperation(scope, op, null)
    return { ...task, status: result.to, revision: result.revision }
  } catch (error) {
    settlePendingOperation(scope, op, error)
    throw error
  }
}

function DocItem({ loanFileId, item, onDone, task }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onPick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 25 * 1024 * 1024) { setError('That file is over 25 MB — please upload a smaller file.'); return }
    if (task && task.status !== 'in_progress') { setError('This task is not ready for upload. Refresh and try again.'); return }

    let operation = null
    let scope = null
    if (task) {
      const material = {
        taskId: task.id,
        documentId: item.documentId,
        expectedRevision: Number(task.revision || 0),
      }
      scope = `task-finalize:${task.id}`
      operation = getOrCreatePendingOperation(scope, material)
    }

    setError(''); setBusy(true)
    try {
      await uploadDocument(loanFileId, item.docKey, file, task ? {
        taskId: task.id,
        requiredDocumentId: item.documentId,
        expectedRevision: task.revision,
        idempotencyKey: operation.idempotencyKey,
      } : null)
      if (task) settlePendingOperation(scope, operation, null)
      await onDone()
    } catch (err) {
      if (task) settlePendingOperation(scope, operation, err)
      setError(err?.message || 'Upload failed. Please try again.')
    } finally { setBusy(false) }
  }

  const canUpload = ['missing', 'requested', 'rejected'].includes(item.status)
  const cta = item.status === 'rejected' ? 'Re-upload' : canUpload ? 'Upload' : 'Replace'
  return (
    <div className="row">
      <div className="grow">
        <div className="rlabel">{item.label}</div>
        {item.why && <div className="rsub" style={{ marginTop: 2 }}>Why: {item.why}</div>}
        <div className="rsub"><StatusChip status={item.status} />
          {item.uploadedAt && item.status !== 'rejected' && <span className="muted"> · {shortDate(item.uploadedAt)}</span>}
        </div>
        {item.status === 'rejected' && item.rejectReason && <div className="rsub" style={{ color: 'var(--red)', marginTop: 6 }}>Needs another: {item.rejectReason}</div>}
        {error && <div className="rsub" style={{ color: 'var(--red)', marginTop: 6 }}>{error}</div>}
      </div>
      <div style={{ flex: '0 0 auto' }}>
        <input ref={inputRef} type="file" accept="image/*,application/pdf" hidden onChange={onPick} />
        <button className={`btn btn-sm ${canUpload ? 'btn-primary' : 'btn-ghost'}`} disabled={busy || (task && task.status !== 'in_progress')} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : cta}
        </button>
      </div>
    </div>
  )
}

export default function Documents() {
  const { loanFileId } = useParams()
  const [params] = useSearchParams()
  const taskId = params.get('task') || null
  const [data, setData] = useState(null)
  const [task, setTask] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [prepared, setPrepared] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const [checklist, detail] = await Promise.all([
      getChecklist(loanFileId),
      taskId ? getTaskDetail(taskId) : Promise.resolve(null),
    ])
    setData(checklist)
    setTask(detail?.task || null)
    return { checklist, task: detail?.task || null }
  }, [loanFileId, taskId])

  useEffect(() => {
    let alive = true
    setLoading(true); setPrepared(false)
    load().then(async ({ task: loadedTask }) => {
      if (!alive || !loadedTask) { if (alive) setPrepared(true); return }
      let next = loadedTask
      const actions = borrowerPreparationActions(next.status)
      if (actions === null) { setPrepared(true); return }
      for (const action of actions) next = await transitionBorrowerTask(next, action)
      if (alive) { setTask(next); setPrepared(true) }
    }).catch((err) => { if (alive) setError(err?.message || 'Could not load your checklist.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [load])

  // Lost-response recovery: if the upload object already exists, retry only the same finalize
  // operation before asking the borrower to upload again.
  useEffect(() => {
    if (!prepared || !taskId || !task || task.status !== 'in_progress') return
    const scope = `task-finalize:${task.id}`
    const pending = readPendingOperation(scope)
    if (!pending?.material?.documentId) return
    completeUpload(pending.material.documentId, {
      taskId: task.id,
      expectedRevision: pending.material.expectedRevision,
      idempotencyKey: pending.idempotencyKey,
    }).then(() => {
      settlePendingOperation(scope, pending, null)
      return load()
    }).catch((err) => settlePendingOperation(scope, pending, err))
  }, [prepared, taskId, task, load])

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!data) return null

  let items = data.items
  if (taskId) {
    if (!task) return <Alert kind="error">Task not found.</Alert>
    const required = items.find((i) => i.documentId === task.required_document_id)
    if (!required) return <Alert kind="error">The requested document is not available on this file.</Alert>
    items = [required]
  }
  const borrowerItems = items.filter((i) => i.who !== 'coborrower')
  const coItems = items.filter((i) => i.who === 'coborrower')

  return (
    <>
      <Link to="/portal" className="backlink">← Back to my loan</Link>
      <div className="spread"><h1 className="mb0">Your documents</h1><span className="chip">{data.uploaded} of {data.total} done</span></div>
      <p className="muted">Snap a photo or upload a file — no scanner needed. Everything is encrypted and private to your loan team.</p>
      {task && <p className="fileno">Task: {task.title} · {task.status.replaceAll('_', ' ')}</p>}

      {borrowerItems.length > 0 && <div className="card">
        <div className="card-head"><h2>Your items</h2></div>
        {borrowerItems.map((it) => <DocItem key={it.documentId || it.docKey} loanFileId={loanFileId} item={it} onDone={load} task={task} />)}
      </div>}
      {coItems.length > 0 && <div className="card">
        <div className="card-head"><h2>Co-borrower items</h2></div>
        {coItems.map((it) => <DocItem key={it.documentId || it.docKey} loanFileId={loanFileId} item={it} onDone={load} task={task} />)}
      </div>}
      {!taskId && data.remaining === 0 && <Alert kind="ok">All documents are in — nice work! Your team will review and reach out if anything else is needed.</Alert>}
    </>
  )
}
