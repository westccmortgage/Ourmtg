// Conversational 1003 — final review and attestation (§6.J).
//
// The approved text is displayed in full, separately from the conversation, and the exact
// version shown is echoed back to the server so the record proves what the borrower saw.
// The "not an electronic signature" line sits next to the control, not buried in a document.

import { useEffect, useRef, useState } from 'react'
import { ATTESTATION } from '../attestationText'
import { attest, newIdempotencyKey } from '../api'

const SUBMIT = { en: 'Submit my application', es: 'Enviar mi solicitud', ru: 'Отправить заявку' },
  DONE = {
    en: 'Submitted. Your loan team will review it and follow up.',
    es: 'Enviado. Su equipo lo revisará y le contactará.',
    ru: 'Отправлено. Кредитная команда проверит и свяжется с вами.',
  }

export default function AttestationPanel({ loanFileId, locale = 'en', onAttested }) {
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  // When the text was put on screen — recorded alongside the acceptance timestamp.
  const presentedAt = useRef(new Date().toISOString())

  useEffect(() => { presentedAt.current = new Date().toISOString() }, [])

  const body = ATTESTATION.body[locale] || ATTESTATION.body.en
  const title = ATTESTATION.title[locale] || ATTESTATION.title.en
  const acceptLabel = ATTESTATION.acceptLabel[locale] || ATTESTATION.acceptLabel.en
  const notEsign = ATTESTATION.notAnEsignature[locale] || ATTESTATION.notAnEsignature.en

  async function submit() {
    if (!accepted || busy) return
    setBusy(true); setError('')
    try {
      const res = await attest({
        loanFileId,
        documentVersion: ATTESTATION.version,
        presentedAt: presentedAt.current,
        locale,
        idempotencyKey: newIdempotencyKey('attest'),
      })
      setDone(true)
      onAttested?.(res)
    } catch (e) {
      setError(e.message || 'Could not submit. Please try again.')
    } finally { setBusy(false) }
  }

  if (done) return <div className="c1003-attest c1003-attest--done"><p>{DONE[locale] || DONE.en}</p></div>

  return (
    <section className="c1003-attest">
      <h2>{title}</h2>
      {body.map((line, i) => <p key={i}>{line}</p>)}

      {/* Courtesy translations are labeled as such — English is controlling until reviewed. */}
      {locale !== ATTESTATION.controllingLocale && (
        <p className="muted" style={{ fontSize: 12 }}>
          {locale === 'es'
            ? 'Traducción de cortesía. La versión en inglés es la que rige.'
            : 'Перевод предоставлен для удобства. Английская версия является определяющей.'}
        </p>
      )}

      <label className="c1003-attest-accept">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>{acceptLabel}</span>
      </label>
      <p className="muted" style={{ fontSize: 12 }}>{notEsign}</p>

      {error && <p className="error-text">{error}</p>}
      <button className="btn btn-primary btn-block" disabled={!accepted || busy} onClick={submit}>
        {busy ? '…' : (SUBMIT[locale] || SUBMIT.en)}
      </button>
    </section>
  )
}
