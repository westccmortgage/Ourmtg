// Phase 1C — loan-team task pilot card (§11). Focused: create ONE borrower document task and
// review submitted tasks (accept / reject-with-reason / request more info / reopen). Not a
// generic workflow builder. Flag-gated by the caller (flags.loanTeamTaskPilot). Mobile-safe.
import { useEffect, useState, useCallback } from 'react'
import { listTasks, createTask, transitionTask } from '../lib/api'
import { taskStatusLabel } from '../lib/taskLabels'
import { Alert, Empty } from './ui'

const REVIEW_ACTIONS = [
  { action: 'accept', label: 'Accept', kind: 'btn-primary' },
  { action: 'reject', label: 'Reject', kind: 'btn-ghost', needsReason: true },
  { action: 'requestMoreInfo', label: 'More info', kind: 'btn-ghost' },
  { action: 'reopen', label: 'Reopen', kind: 'btn-ghost' },
]

export default function TeamTaskCard({ loanFileId }) {
  const [tasks, setTasks] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ title: '', borrowerExplanation: '', internalRequirement: '', dueAt: '', isBlocking: false, requiredDocumentType: '' })

  const load = useCallback(() => {
    return listTasks(loanFileId).then((r) => setTasks(r?.tasks || [])).catch((e) => setError(e?.message || 'Could not load tasks.'))
  }, [loanFileId])
  useEffect(() => { load() }, [load])

  async function submit(e) {
    e.preventDefault()
    if (!form.title.trim()) { setError('A borrower-facing title is required.'); return }
    setBusy(true); setError('')
    try {
      // F1: a stable per-submit idempotency key so a retried request creates ONE task.
      const idempotencyKey = (globalThis.crypto?.randomUUID?.() || `create-${loanFileId}-${Date.now()}`)
      await createTask({ loanFileId, taskType: 'document_request', idempotencyKey, ...form })
      setForm({ title: '', borrowerExplanation: '', internalRequirement: '', dueAt: '', isBlocking: false, requiredDocumentType: '' })
      await load()
    } catch (e2) { setError(e2?.message || 'Could not create task.') } finally { setBusy(false) }
  }

  async function act(taskId, action, needsReason) {
    let reason
    if (needsReason) {
      reason = window.prompt('Borrower-visible reason for rejection:')
      if (!reason || reason.trim().length < 3) return
    }
    setBusy(true); setError('')
    try {
      await transitionTask(taskId, action, reason ? { reason } : {})
      await load()
    } catch (e) { setError(e?.message || 'Could not update task.') } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Borrower tasks (pilot)</h2>{tasks && <span className="chip gray">{tasks.length}</span>}</div>
      {error && <Alert kind="error">{error}</Alert>}

      <form onSubmit={submit} style={{ marginBottom: 16 }}>
        <div className="field"><label>Borrower-facing title</label>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Upload your last 30 days of pay stubs" /></div>
        <div className="field"><label>Plain-language explanation (borrower sees this)</label>
          <textarea rows={2} value={form.borrowerExplanation} onChange={(e) => setForm({ ...form, borrowerExplanation: e.target.value })} /></div>
        <div className="field"><label>Internal requirement (team only)</label>
          <input value={form.internalRequirement} onChange={(e) => setForm({ ...form, internalRequirement: e.target.value })} placeholder="Underwriter note — never shown to borrower" /></div>
        <div className="grid2">
          <div className="field"><label>Due date</label>
            <input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></div>
          <div className="field"><label>Expected document type</label>
            <input value={form.requiredDocumentType} onChange={(e) => setForm({ ...form, requiredDocumentType: e.target.value })} placeholder="paystubs_30d" /></div>
        </div>
        <label className="check"><input type="checkbox" checked={form.isBlocking} onChange={(e) => setForm({ ...form, isBlocking: e.target.checked })} /> Blocks the loan</label>
        <button className="btn btn-primary btn-sm" disabled={busy} style={{ marginTop: 10 }}>{busy ? 'Working…' : 'Create task'}</button>
      </form>

      {tasks && tasks.length === 0 && <Empty>No tasks yet. Create the first borrower document task above.</Empty>}
      {tasks && tasks.map((t) => (
        <div className="row" key={t.id}>
          <div className="grow">
            <div className="rlabel">{t.title} {t.is_blocking && <span className="chip">Blocking</span>}</div>
            {t.internal_requirement && <div className="rsub" style={{ color: 'var(--muted)' }}>Internal: {t.internal_requirement}</div>}
            <div className="rsub">Status: {taskStatusLabel(t.status, 'en')}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {t.status === 'submitted' && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(t.id, 'sendToTeamReview')}>To review</button>
            )}
            {t.status === 'team_review' && REVIEW_ACTIONS.map((a) => (
              <button key={a.action} className={`btn btn-sm ${a.kind}`} disabled={busy} onClick={() => act(t.id, a.action, a.needsReason)}>{a.label}</button>
            ))}
            {(t.status === 'submitted') && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(t.id, 'requestMoreInfo')}>More info</button>
            )}
            {t.status === 'accepted' && (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(t.id, 'complete')}>Complete</button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
