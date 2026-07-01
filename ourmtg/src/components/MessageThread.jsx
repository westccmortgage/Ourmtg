// Two-way message thread on a loan file: timeline list + composer. Used by the
// borrower dashboard and the LO/processor file detail. `messages` come from the
// caller (RLS read for borrowers, portal-file-detail for internal); sending goes
// through portal-message-send, then onSent() reloads.
import { useState } from 'react'
import { sendMessage } from '../lib/api'
import { relTime } from '../lib/format'
import { Alert, Empty } from './ui'

const AUTHOR_LABEL = {
  borrower: 'Borrower', coborrower: 'Co-borrower', lo: 'Loan officer',
  processor: 'Processor', realtor: 'Realtor', system: 'System',
}

export default function MessageThread({ loanFileId, messages, onSent, placeholder }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    setBusy(true); setError('')
    try {
      await sendMessage(loanFileId, body)
      setText('')
      await onSent?.()
    } catch (err) {
      setError(err?.message || 'Could not send. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form onSubmit={submit} style={{ marginBottom: 4 }}>
        <Alert kind="error">{error}</Alert>
        <div className="field" style={{ marginBottom: 8 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder || 'Write a message…'}
            rows={2}
            maxLength={4000}
          />
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
          {busy ? 'Sending…' : 'Send message'}
        </button>
      </form>
      {(!messages || messages.length === 0) && <Empty>No messages yet.</Empty>}
      {messages && messages.map((m) => (
        <div className="row" key={m.id}>
          <div className="grow">
            <div className="rlabel" style={{ fontWeight: 500, fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body}</div>
            <div className="rsub">{AUTHOR_LABEL[m.author_role] || m.author_role} · {relTime(m.created_at)}</div>
          </div>
        </div>
      ))}
    </>
  )
}
