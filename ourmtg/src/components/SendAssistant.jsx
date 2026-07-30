// "Send the assistant" — mint a borrower link while you are still on the phone.
//
// The existing path to this outcome is /portal/new-file → save → find the invite form → send
// → select the link out of a read-only input. That is fine when you are working a file at your
// desk and wrong when someone just said "I can't fill out the 1003, send me something now".
// This asks for the two things you actually know during that call — who they are and where to
// reach them — and hands back a link you can paste into a text message.
//
// Everything else the application collects itself. Loan type, purpose, and amount are exactly
// the kind of thing the interview is good at asking for, so requiring them here would be
// making the loan officer do the assistant's job.
import { useState } from 'react'
import { setLoanFile, createInvite } from '../lib/api'
import { Alert } from './ui'
import { conversational1003Enabled } from '../features/conversational-1003/clientFlag'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function SendAssistant() {
  const [form, setForm] = useState({ name: '', contact: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState('')

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function send(e) {
    e.preventDefault()
    setError('')
    const name = form.name.trim()
    const contact = form.contact.trim()
    if (!name) return setError('Enter the borrower’s name.')
    if (!contact) return setError('Enter an email or a mobile number to send the link to.')

    // An email gets the invite delivered automatically; a phone number does not, so the link
    // on screen is the only copy and the caller is told so.
    const isEmail = EMAIL_RE.test(contact)
    setBusy(true)
    try {
      const file = await setLoanFile({ borrowerName: name })
      const invite = await createInvite({
        loanFileId: file.loanFileId,
        role: 'borrower',
        name,
        destination: 'application',
        ...(isEmail ? { email: contact } : { phone: contact }),
      })
      setResult({ ...invite, name, isEmail, contact, loanFileId: file.loanFileId })
      setForm({ name: '', contact: '' })
    } catch (err) {
      setError(err?.message || 'Could not create the link. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function copy(text, which) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(''), 2000)
    } catch {
      // Clipboard is blocked in some embedded browsers — the link stays selectable on screen.
      setError('Copy is blocked in this browser. Select the link and copy it manually.')
    }
  }

  if (!conversational1003Enabled()) return null

  // Prefer the short form for anything a person has to paste, read aloud, or retype.
  const shareUrl = result ? (result.shortUrl || result.inviteUrl) : ''
  const smsText = result
    ? `Hi ${result.name} — here's the assistant that fills out your loan application for you. Just answer in your own words: ${shareUrl}`
    : ''

  return (
    <div className="card">
      <div className="card-head">
        <h2>Send the assistant</h2>
        <span className="chip gray">while you’re on the call</span>
      </div>

      {!result && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Creates the file and the borrower’s link in one step. They answer in their own words;
            loan type, purpose, and amount are collected by the interview, so you don’t need them now.
          </p>
          <form onSubmit={send}>
            <div className="grid2">
              <div className="field">
                <label htmlFor="sa-name">Borrower name</label>
                <input id="sa-name" required value={form.name} onChange={set('name')} maxLength={120}
                       placeholder="Milik Muchnik" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="sa-contact">Email or mobile</label>
                <input id="sa-contact" required value={form.contact} onChange={set('contact')} maxLength={160}
                       placeholder="name@email.com" autoComplete="off" />
                <p className="hint">An email is sent automatically. For a phone number, copy the link and text it.</p>
              </div>
            </div>
            {error && <Alert kind="error">{error}</Alert>}
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create link'}</button>
          </form>
        </>
      )}

      {result && (
        <>
          <Alert kind="ok">
            File created for {result.name}.{' '}
            {result.emailed
              ? `The link was emailed to ${result.contact}.`
              : 'Nothing was sent automatically — copy the link below and text it.'}
          </Alert>

          <div className="field">
            <label htmlFor="sa-link">Their link</label>
            <input id="sa-link" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
          </div>

          <div className="pill-row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => copy(shareUrl, 'link')}>
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => copy(smsText, 'sms')}>
              {copied === 'sms' ? 'Copied' : 'Copy text message'}
            </button>
            <a className="btn btn-sm" href={`/portal/file/${result.loanFileId}`}>Open the file</a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResult(null); setError('') }}>
              Send another
            </button>
          </div>

          <p className="hint" style={{ marginTop: 12 }}>
            The link is tied to {result.isEmail ? 'that email address' : 'the person you send it to'} and expires.
            Opening it takes them straight into the application.
          </p>
        </>
      )}
    </div>
  )
}
