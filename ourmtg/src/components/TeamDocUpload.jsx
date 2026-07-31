// Team-side document upload + "ask the borrower for it instead".
//
// Until now the file page could only *request* a document. That is the wrong half of the
// problem when the document is already sitting in a processor's inbox: the answer to "where do
// I put this" was effectively "email the borrower and ask them to send you what you already
// have". Everything needed to accept it directly was already in place — the private bucket, the
// per-file folder, the signed upload — with no control wired to it.
//
// This card is only the first half of the answer: put it in the file yourself. The other half —
// sending the borrower a link that opens on their upload page — belongs to the invite card,
// which already collects the email an invite has to be bound to. Duplicating it here would have
// meant minting a link with nobody attached to it.
import { useEffect, useState } from 'react'
import { getChecklist, uploadDocument } from '../lib/api'
import { Alert } from './ui'

export default function TeamDocUpload({ loanFileId, onUploaded }) {
  const [items, setItems] = useState(null)
  const [docKey, setDocKey] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  useEffect(() => {
    let alive = true
    getChecklist(loanFileId)
      .then((r) => { if (alive) setItems(r?.items || []) })
      .catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [loanFileId])

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''            // let the same file be picked again after an error
    if (!file || !docKey) return
    setError(''); setOk(''); setBusy('upload')
    try {
      await uploadDocument(loanFileId, docKey, file)
      setOk('Added to the file. It shows as uploaded and is waiting for review.')
      setDocKey('')
      onUploaded?.()
    } catch (err) {
      setError(err?.message || 'That upload did not go through.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Put a document in this file</h2></div>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything for this loan lives here — whether the borrower uploaded it or you did.
      </p>

      <div className="field">
        <label htmlFor="tdu-kind">What is it?</label>
        <select id="tdu-kind" value={docKey} onChange={(e) => setDocKey(e.target.value)} disabled={!items}>
          <option value="">{items ? 'Choose a document type…' : 'Loading…'}</option>
          {(items || []).map((i) => (
            <option key={i.docKey} value={i.docKey}>
              {i.label}{i.status && i.status !== 'requested' ? ` — ${i.status}` : ''}
            </option>
          ))}
        </select>
        <p className="hint">Choosing an already-requested item files your copy against that request.</p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      <div className="pill-row">
        <label className={`btn btn-primary btn-sm${!docKey || busy ? ' disabled' : ''}`}
               style={{ cursor: docKey && !busy ? 'pointer' : 'not-allowed' }}>
          {busy === 'upload' ? 'Uploading…' : 'Choose file'}
          <input type="file" onChange={onFile} disabled={!docKey || !!busy} style={{ display: 'none' }} />
        </label>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        Don’t have it yet? Use <b>Invite to portal</b> below and set “Open on” to their documents —
        the link drops them straight onto their upload page.
      </p>
    </div>
  )
}
