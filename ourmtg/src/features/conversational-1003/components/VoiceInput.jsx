// Conversational 1003 — voice input (§16).
//
// HONEST SCOPE: there is no approved server-side transcription provider configured for this
// deployment. Rather than fake it, this component uses the browser's own SpeechRecognition
// where it exists (progressive enhancement) and otherwise reports plainly that dictation is
// unavailable. Text input is ALWAYS available and is never blocked by any of this.
//
// What it does guarantee, per §16:
//   • capability detection before offering the control
//   • an explicit recording state with stop AND cancel
//   • a transcript PREVIEW the borrower edits before it is submitted (nothing is sent from
//     the microphone straight into the application)
//   • no raw audio retained — the browser API hands back text; we never record or upload audio
//   • the mic is refused outright on secure fields (never say an SSN aloud)

import { useEffect, useRef, useState } from 'react'

export function speechSupported() {
  if (typeof window === 'undefined') return false
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

const LOCALE_TAG = { en: 'en-US', es: 'es-US', ru: 'ru-RU' }

const COPY = {
  start: { en: 'Speak', es: 'Hablar', ru: 'Говорить' },
  listening: { en: 'Listening…', es: 'Escuchando…', ru: 'Слушаю…' },
  stop: { en: 'Stop', es: 'Detener', ru: 'Стоп' },
  cancel: { en: 'Cancel', es: 'Cancelar', ru: 'Отмена' },
  review: {
    en: 'Check what I heard, edit if needed, then send.',
    es: 'Revise lo que escuché, edite si es necesario y envíe.',
    ru: 'Проверьте распознанный текст, при необходимости исправьте и отправьте.',
  },
  unsupported: {
    en: 'Dictation is not available in this browser. You can type your answer instead.',
    es: 'El dictado no está disponible en este navegador. Puede escribir su respuesta.',
    ru: 'Диктовка недоступна в этом браузере. Вы можете ввести ответ текстом.',
  },
  failed: {
    en: "I couldn't catch that. Try again, or type your answer.",
    es: 'No pude captarlo. Intente de nuevo o escriba su respuesta.',
    ru: 'Не удалось распознать. Попробуйте снова или введите текст.',
  },
  secure: {
    en: 'For your security, this one has to be typed into the secure box.',
    es: 'Por su seguridad, esto debe escribirse en el cuadro seguro.',
    ru: 'В целях безопасности это нужно ввести в защищённое поле.',
  },
}
const t = (k, locale) => COPY[k][locale] || COPY[k].en

export default function VoiceInput({ locale = 'en', disabled = false, secure = false, onTranscript }) {
  const [state, setState] = useState('idle') // idle | listening | error
  const [preview, setPreview] = useState('')
  const recRef = useRef(null)
  const cancelledRef = useRef(false)

  // Always release the microphone if the borrower navigates away mid-recording.
  useEffect(() => () => { try { recRef.current?.abort() } catch { /* already stopped */ } }, [])

  if (secure) return <p className="muted" style={{ fontSize: 13 }}>{t('secure', locale)}</p>
  if (!speechSupported()) {
    return <p className="muted" style={{ fontSize: 13 }}>{t('unsupported', locale)}</p>
  }

  function start() {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new Impl()
    rec.lang = LOCALE_TAG[locale] || 'en-US'
    rec.interimResults = true
    rec.continuous = false
    cancelledRef.current = false

    let text = ''
    rec.onresult = (e) => {
      text = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim()
      setPreview(text)
    }
    rec.onerror = () => { setState('error') }
    rec.onend = () => {
      recRef.current = null
      if (cancelledRef.current) { setState('idle'); setPreview(''); return }
      setState(text ? 'idle' : 'error')
    }
    recRef.current = rec
    setPreview('')
    setState('listening')
    try { rec.start() } catch { setState('error') }
  }

  function stop() { try { recRef.current?.stop() } catch { /* already ended */ } }
  function cancel() {
    cancelledRef.current = true
    try { recRef.current?.abort() } catch { /* already ended */ }
    setState('idle'); setPreview('')
  }

  return (
    <div className="voice-input">
      {state !== 'listening' && (
        <button type="button" className="btn btn-ghost" onClick={start} disabled={disabled}>
          🎙 {t('start', locale)}
        </button>
      )}
      {state === 'listening' && (
        <div className="voice-live" role="status" aria-live="polite">
          <span className="voice-dot" aria-hidden="true" /> {t('listening', locale)}
          <button type="button" className="btn btn-ghost" onClick={stop}>{t('stop', locale)}</button>
          <button type="button" className="btn btn-ghost" onClick={cancel}>{t('cancel', locale)}</button>
        </div>
      )}
      {state === 'error' && <p className="muted" style={{ fontSize: 13 }}>{t('failed', locale)}</p>}

      {/* The borrower always reviews and edits before anything is submitted. */}
      {preview && state !== 'listening' && (
        <div className="voice-preview">
          <label htmlFor="voice-preview-text" className="muted" style={{ fontSize: 13 }}>
            {t('review', locale)}
          </label>
          <textarea
            id="voice-preview-text"
            value={preview}
            rows={3}
            onChange={(e) => setPreview(e.target.value)}
          />
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => { onTranscript(preview); setPreview('') }}>
              {locale === 'es' ? 'Enviar' : locale === 'ru' ? 'Отправить' : 'Send'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPreview('')}>
              {t('cancel', locale)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
