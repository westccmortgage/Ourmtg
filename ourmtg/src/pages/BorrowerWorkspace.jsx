// The borrower's one screen.
//
// ── What this replaces ──────────────────────────────────────────────────────
// Three places that each knew half the answer: a checklist that knew about documents, an
// application that knew about questions, and a timeline that knew what somebody had said. A
// borrower who finished the checklist was told "all in — nice work!" while two 1003 questions
// were still open, and the only way to find out was a phone call.
//
// So: one page, one list, one number, and one obvious next thing. Every piece of it comes from
// portal-file-state, which is the same array the loan team's panel renders — the two cannot
// disagree, because neither of them computes anything.
//
// ── What is deliberately not here ───────────────────────────────────────────
// Anything about whether this borrower qualifies. Not hidden — absent: findings are never
// borrower-owned, so the payload this page receives has no field they could be rendered from.
// The number on this page is arithmetic over a checklist and says so, in the page, every time.

import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getFileState, listMessages } from '../lib/api'
import { shortDate } from '../lib/format'
import { Alert, Spinner } from '../components/ui'

const KIND_ACTION = {
  document: 'Upload it',
  credit_authorization: 'Give permission',
  application_conflict: 'Confirm the answer',
  application_answer: 'Answer it',
}

export default function BorrowerWorkspace() {
  const { loanFileId } = useParams()
  const [state, setState] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [s, m] = await Promise.all([
      getFileState(loanFileId),
      // Fail-soft: the timeline is nice to have, and losing it must not cost the borrower the
      // list of what they still need to do.
      listMessages(loanFileId).catch(() => []),
    ])
    setState(s)
    setMessages(m.filter((x) => x.author_role === 'assistant' || x.direction === 'out'))
  }, [loanFileId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    load().catch((e) => { if (alive) setError(e?.message || 'Could not load your file.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [load])

  // Something is being read right now. One poll, not a permanent timer: the read takes tens of
  // seconds and a page that refetches forever is a page that runs down a phone battery.
  useEffect(() => {
    if (!state?.reading) return undefined
    const t = setTimeout(() => { load().catch(() => {}) }, 20_000)
    return () => clearTimeout(t)
  }, [state?.reading, load])

  if (loading) return <Spinner />
  if (error) return <Alert kind="error">{error}</Alert>
  if (!state) return null

  const { operational, tasks, next, sections } = state
  const done = operational.complete

  return (
    <>
      <Link to="/portal" className="backlink">← Back to my loan</Link>

      <div className="spread">
        <h1 className="mb0">Your application</h1>
        <span className="chip">{operational.percent}% ready</span>
      </div>
      {/* The number never travels without its meaning. A percentage on a mortgage screen is
          read as a chance of approval unless the screen says otherwise, in the screen. */}
      <p className="muted" style={{ marginTop: 4 }}>
        {operational.meaning} It is not {operational.notMeaning.join(', not ')}.
      </p>

      {state.reading > 0 && (
        <Alert kind="info">
          We are reading {state.reading === 1 ? 'a document' : `${state.reading} documents`} you sent.
          This usually takes a minute — you do not need to wait here.
        </Alert>
      )}

      {done ? (
        <div className="card">
          <div className="card-head"><h2>Nothing outstanding</h2></div>
          <div className="row"><div className="grow">
            <p className="muted mb0">
              You have sent everything we asked for. Your loan team is reviewing it, and we will
              be in touch if anything else comes up.
            </p>
          </div></div>
        </div>
      ) : (
        <>
          {next && (
            <div className="card">
              <div className="card-head"><h2>Do this next</h2></div>
              <div className="row">
                <div className="grow">
                  <div className="rlabel">{next.title}</div>
                  {next.requests?.map((r) => (
                    <div key={r} className="rsub" style={{ marginTop: 4 }}>{r}</div>
                  ))}
                </div>
                <div style={{ flex: '0 0 auto' }}>
                  <ActionButton loanFileId={loanFileId} task={next} primary />
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h2>What we still need</h2>
              <span className="chip">{tasks.length}</span>
            </div>
            {tasks.map((t) => (
              <div className="row" key={t.id}>
                <div className="grow">
                  <div className="rlabel">{t.title}</div>
                  <div className="rsub muted">{t.sectionTitle}</div>
                  {t.requests?.map((r) => (
                    <div key={r} className="rsub" style={{ marginTop: 4, color: 'var(--amber, #9a6b00)' }}>{r}</div>
                  ))}
                </div>
                <div style={{ flex: '0 0 auto' }}>
                  <ActionButton loanFileId={loanFileId} task={t} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="card">
        <div className="card-head"><h2>Your sections</h2></div>
        {sections.map((s) => (
          <div className="row" key={s.key}>
            <div className="grow"><div className="rlabel">{s.title}</div></div>
            <div style={{ flex: '0 0 auto' }}>
              <span className="chip">{sectionWord(s)}</span>
            </div>
          </div>
        ))}
      </div>

      {messages.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Messages</h2></div>
          {messages.slice(0, 10).map((m) => (
            <div className="row" key={m.id}>
              <div className="grow">
                {/* Pre-wrap because the follow-up is written as short paragraphs and a bullet
                    list; collapsing them turns a readable ask into a wall. */}
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                <div className="rsub muted" style={{ marginTop: 4 }}>{shortDate(m.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Where a task is actually done.
 *
 * Documents go to the upload screen, which already owns signed URLs, retries and the
 * pending-operation bookkeeping; questions go to the assistant, which owns the interview.
 * Re-implementing either here would be a second way to do the same thing, and the two would
 * drift the first time one of them was fixed.
 */
function ActionButton({ loanFileId, task, primary = false }) {
  const cls = `btn btn-sm ${primary ? 'btn-primary' : 'btn-ghost'}`
  const label = KIND_ACTION[task.kind] || 'Open'
  const to = task.kind === 'document'
    ? `/portal/documents/${loanFileId}`
    : `/application/assistant/${loanFileId}`
  return <Link className={cls} to={to}>{label}</Link>
}

const sectionWord = (s) => (
  s.state === 'not_applicable' ? 'not needed'
    : s.open > 0 ? `${s.open} to do`
      : 'done'
)
