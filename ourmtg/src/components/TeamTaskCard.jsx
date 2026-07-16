// Phase 1C loan-team task pilot. Creates one exact document task for a verified
// borrower audience and renders only lifecycle-valid review actions.
import { useEffect, useState, useCallback } from 'react'
import { listTasks, createTask, transitionTask, getFileDetail } from '../lib/api'
import { taskStatusLabel } from '../lib/taskLabels'
import { teamActionsForTask, actionNeedsBorrowerReason } from '../lib/taskUi'
import { getOrCreatePendingOperation, readPendingOperation, settlePendingOperation } from '../lib/pendingOps'
import { Alert, Empty } from './ui'

const blankForm = {
  title: '', borrowerExplanation: '', internalRequirement: '', dueAt: '', isBlocking: false,
  requiredDocumentType: '', requiredDocumentId: '', audience: 'shared',
}

export default function TeamTaskCard({ loanFileId }) {
  const [tasks, setTasks] = useState(null)
  const [participants, setParticipants] = useState([])
  const [documents, setDocuments] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(blankForm)

  const load = useCallback(() => Promise.all([listTasks(loanFileId), getFileDetail(loanFileId)])
    .then(([taskData, detail]) => {
      setTasks(taskData?.tasks || [])
      setParticipants(detail?.participants || [])
      setDocuments(detail?.documents || [])
    })
    .catch((e) => setError(e?.message || 'Could not load tasks.')), [loanFileId])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    const pending = readPendingOperation(`task-create:${loanFileId}`)
    if (pending?.material?.form) setForm((current) => ({ ...current, ...pending.material.form }))
  }, [loanFileId])

  async function submit(e) {
    e.preventDefault()
    if (!form.title.trim()) { setError('A borrower-facing title is required.'); return }
    if (!form.requiredDocumentId) { setError('Select the exact requested document.'); return }
    if (form.audience !== 'shared' && !participants.some((p) => p.id === form.audience)) {
      setError('Select a verified borrower participant.'); return
    }

    const payload = {
      loanFileId,
      taskType: 'document_request',
      title: form.title,
      borrowerExplanation: form.borrowerExplanation,
      internalRequirement: form.internalRequirement,
      dueAt: form.dueAt,
      isBlocking: form.isBlocking,
      requiredDocumentType: form.requiredDocumentType,
      requiredDocumentId: form.requiredDocumentId,
      sharedWithBorrowers: form.audience === 'shared',
      responsibleUserId: form.audience === 'shared' ? null : form.audience,
    }
    const scope = `task-create:${loanFileId}`
    const op = getOrCreatePendingOperation(scope, { form, payload }, undefined, { reuseExisting: true })
    const material = op.material?.payload || payload
    setBusy(true); setError('')
    try {
      await createTask({ ...material, idempotencyKey: op.idempotencyKey })
      settlePendingOperation(scope, op, null)
      setForm(blankForm)
      await load()
    } catch (err) {
      settlePendingOperation(scope, op, err)
      setError(err?.message || 'Could not create task.')
    } finally { setBusy(false) }
  }

  async function act(task, action) {
    let borrowerVisibleReason = null
    if (actionNeedsBorrowerReason(action)) {
      borrowerVisibleReason = window.prompt('Borrower-visible reason:')
      if (!borrowerVisibleReason || borrowerVisibleReason.trim().length < 3) return
    }
    const payload = {
      taskId: task.id,
      action,
      expectedRevision: Number(task.revision || 0),
      ...(borrowerVisibleReason ? { borrowerVisibleReason } : {}),
    }
    const scope = `task-transition:${task.id}:${action}`
    const op = getOrCreatePendingOperation(scope, payload, undefined, { reuseExisting: true })
    const material = op.material || payload
    setBusy(true); setError('')
    try {
      await transitionTask(material.taskId, material.action, { ...material, idempotencyKey: op.idempotencyKey })
      settlePendingOperation(scope, op, null)
      await load()
    } catch (err) {
      settlePendingOperation(scope, op, err)
      setError(err?.message || 'Could not update task.')
    } finally { setBusy(false) }
  }

  const availableDocs = documents.filter((d) => ['requested', 'rejected'].includes(d.status))

  return (
    <div className="card">
      <div className="card-head"><h2>Borrower tasks (pilot)</h2>{tasks && <span className="chip gray">{tasks.length}</span>}</div>
      {error && <Alert kind="error">{error}</Alert>}

      <form onSubmit={submit} style={{ marginBottom: 16 }}>
        <div className="field"><label>Borrower-facing title</label>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Upload your latest bank statement" /></div>
        <div className="field"><label>Plain-language explanation</label>
          <textarea rows={2} value={form.borrowerExplanation} onChange={(e) => setForm({ ...form, borrowerExplanation: e.target.value })} /></div>
        <div className="field"><label>Internal requirement (team only)</label>
          <input value={form.internalRequirement} onChange={(e) => setForm({ ...form, internalRequirement: e.target.value })} /></div>
        <div className="grid2">
          <div className="field"><label>Borrower audience</label>
            <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              <option value="shared">All approved borrowers</option>
              {participants.map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.email || p.id.slice(0, 8)} — {p.visibility === 'coborrower' ? 'Co-borrower' : 'Borrower'}</option>
              ))}
            </select></div>
          <div className="field"><label>Exact requested document</label>
            <select value={form.requiredDocumentId} onChange={(e) => setForm({ ...form, requiredDocumentId: e.target.value })}>
              <option value="">Select a document…</option>
              {availableDocs.map((d) => <option key={d.id} value={d.id}>{d.label} — {d.who}</option>)}
            </select></div>
        </div>
        <div className="grid2">
          <div className="field"><label>Due date</label>
            <input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></div>
          <div className="field"><label>Document type</label>
            <input value={form.requiredDocumentType} onChange={(e) => setForm({ ...form, requiredDocumentType: e.target.value })} /></div>
        </div>
        <label className="check"><input type="checkbox" checked={form.isBlocking} onChange={(e) => setForm({ ...form, isBlocking: e.target.checked })} /> Blocks the loan</label>
        <button className="btn btn-primary btn-sm" disabled={busy} style={{ marginTop: 10 }}>{busy ? 'Working…' : 'Create and assign task'}</button>
      </form>

      {tasks && tasks.length === 0 && <Empty>No tasks yet.</Empty>}
      {tasks && tasks.map((t) => (
        <div className="row" key={t.id}>
          <div className="grow">
            <div className="rlabel">{t.title} {t.is_blocking && <span className="chip">Blocking</span>}</div>
            {t.internal_requirement && <div className="rsub muted">Internal: {t.internal_requirement}</div>}
            <div className="rsub">Status: {taskStatusLabel(t.status, 'en')}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {teamActionsForTask(t.status).map((a) => (
              <button key={a.action} className={`btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`} disabled={busy} onClick={() => act(t, a.action)}>{a.label}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
