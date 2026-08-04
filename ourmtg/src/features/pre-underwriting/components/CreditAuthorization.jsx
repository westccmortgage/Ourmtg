// The borrower authorizing a credit check.
//
// Written to answer the three questions a borrower actually has, in the order they have them,
// before the button rather than after it: will this hurt my score, can I still shop around, and
// does agreeing mean I am approved. A consent screen that leaves those unanswered gets consent
// that is not really informed, whatever the checkbox says.
//
// `presentedAt` is stamped when the text is first rendered — not when the button is pressed —
// so what is recorded is when this person was actually shown this wording. The server refuses an
// acceptance whose version does not match what it currently publishes, which is what makes the
// record mean something a year from now.

import { useEffect, useRef, useState } from 'react'
import { Alert } from '../../../components/ui'
import { getCreditAuthorization, authorizeCredit } from '../api'

export default function CreditAuthorization({ loanFileId, locale = 'en', onAuthorized }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const presentedAt = useRef(null)

  useEffect(() => {
    let alive = true
    getCreditAuthorization(loanFileId)
      .then((s) => {
        if (!alive) return
        setState(s)
        // Stamped on first render of the text, not on click.
        if (!s.authorized && s.canAuthorize && !presentedAt.current) {
          presentedAt.current = new Date().toISOString()
        }
      })
      .catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [loanFileId])

  async function accept() {
    setBusy(true); setError('')
    try {
      const res = await authorizeCredit({
        loanFileId,
        documentVersion: state.documentVersion,
        presentedAt: presentedAt.current || new Date().toISOString(),
      })
      setState((s) => ({ ...s, authorized: true, ...res }))
      onAuthorized?.(res)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  if (error && !state) return <Alert kind="error">{error}</Alert>
  if (!state) return null
  if (!state.canAuthorize) return null              // the team sees this on their own panel
  if (state.authorized) {
    return (
      <div className="card">
        <div className="card-head"><h2>Credit check</h2><span className="chip green">Authorized</span></div>
        <p className="mb0 muted">
          Thank you — that is done. You gave permission for one credit check for this loan.
          {state.expiresAt ? ` It covers a check made before ${new Date(state.expiresAt).toLocaleDateString()}.` : ''}
        </p>
      </div>
    )
  }

  const t = state.text
  const body = t.body[locale] || t.body.en

  return (
    <div className="card">
      <div className="card-head"><h2>{t.title[locale] || t.title.en}</h2></div>
      {body.map((p, i) => <p key={i} style={i === 0 ? { marginTop: 0 } : undefined}>{p}</p>)}
      {error && <Alert kind="error">{error}</Alert>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={accept}>
        {busy ? 'Recording…' : (t.accept[locale] || t.accept.en)}
      </button>
      <p className="hint" style={{ marginTop: 10 }}>
        You can withdraw this at any time before a report is ordered. Ask your loan officer, or
        reply to any message from us.
      </p>
    </div>
  )
}
