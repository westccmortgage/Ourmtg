// Conversational 1003 — the borrower workspace (§18).
//
// Mobile-first. One question at a time, the borrower's captured facts visible as editable
// chips, and the conversation as the primary interface — there is no long form hiding behind
// this screen.
//
// Everything shown here comes from the server: the next question, progress, and completeness
// are computed by the deterministic engine, not by this component.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../../../lib/auth'
import { useLang } from '../../../lib/i18n'
import { Alert } from '../../../components/ui'
import VoiceInput from '../components/VoiceInput'
import SecureFieldInput from '../components/SecureFieldInput'
import ApplicationReview from '../components/ApplicationReview'
import AttestationPanel from '../components/AttestationPanel'
import {
  getSession, sendTurn, confirmValues, saveSecureField, newIdempotencyKey,
} from '../api'

const COPY = {
  title: { en: 'Your application', es: 'Su solicitud', ru: 'Ваша заявка' },
  intro: {
    en: 'Answer in your own words. If something is unclear, just say so — I can explain any question.',
    es: 'Responda con sus propias palabras. Si algo no está claro, dígamelo y se lo explico.',
    ru: 'Отвечайте своими словами. Если что-то непонятно — скажите, я объясню.',
  },
  placeholder: { en: 'Type your answer…', es: 'Escriba su respuesta…', ru: 'Введите ответ…' },
  send: { en: 'Send', es: 'Enviar', ru: 'Отправить' },
  saved: { en: 'Saved', es: 'Guardado', ru: 'Сохранено' },
  progress: { en: 'Application progress', es: 'Progreso', ru: 'Прогресс' },
  reviewToggle: { en: 'What you have told me', es: 'Lo que me ha dicho', ru: 'Что вы уже указали' },
  correct: { en: 'Correct', es: 'Correcto', ru: 'Верно' },
  change: { en: 'Change it', es: 'Cambiarlo', ru: 'Изменить' },
  unsure: { en: "I'm not sure", es: 'No estoy seguro', ru: 'Не уверен' },
  notApproval: {
    en: 'Completing this application is not a loan approval, pre-approval, or a commitment to lend.',
    es: 'Completar esta solicitud no es una aprobación, preaprobación ni compromiso de préstamo.',
    ru: 'Заполнение заявки не является одобрением кредита или обязательством его предоставить.',
  },
  loading: { en: 'Loading your application…', es: 'Cargando su solicitud…', ru: 'Загрузка заявки…' },
}
const t = (k, locale) => COPY[k][locale] || COPY[k].en

export default function ApplicationAssistant() {
  const { loanFileId } = useParams()
  const { user } = useAuth()
  // Reuse the app's existing language switcher (it already lives in the site header) rather
  // than rendering a second one on this page.
  const { lang: locale } = useLang()
  const [session, setSession] = useState(null)
  const [thread, setThread] = useState([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showReview, setShowReview] = useState(false)
  const [secureError, setSecureError] = useState('')
  const bottomRef = useRef(null)

  // One key per pending submission, held across retries so a resend can never double-write.
  const pendingKey = useRef(null)

  const load = useCallback(async () => {
    try {
      const s = await getSession(loanFileId, locale)
      setSession(s)
      if (s.nextQuestion) {
        setThread((prev) => (prev.length ? prev : [{ role: 'assistant', question: s.nextQuestion }]))
      }
    } catch (e) {
      setError(e.message || 'Could not load your application.')
    }
  }, [loanFileId, locale])

  useEffect(() => { load() }, [load])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [thread.length])

  const question = session?.nextQuestion || null

  async function submit(value, { intent = 'answer', inputMode = 'text' } = {}) {
    const body = String(value ?? '').trim()
    if (intent === 'answer' && !body) return
    if (busy) return
    setBusy(true); setError('')
    if (!pendingKey.current) pendingKey.current = newIdempotencyKey('turn')

    if (intent === 'answer') setThread((p) => [...p, { role: 'borrower', text: body }])
    setText('')

    try {
      const res = await sendTurn({
        loanFileId, text: body, intent, locale, inputMode,
        askedQuestionId: question?.id, askedFieldPath: question?.fieldPath,
        idempotencyKey: pendingKey.current,
      })
      pendingKey.current = null

      setThread((p) => [...p, {
        role: 'assistant',
        message: res.message,
        accepted: res.accepted,
        confirmation: res.confirmation,
        degradedNotice: res.degradedNotice,
        question: res.nextQuestion,
      }])
      setSession((s) => ({
        ...s,
        nextQuestion: res.nextQuestion,
        review: res.review || s?.review,
        progress: res.progress || s?.progress,
        canAttest: res.canAttest ?? s?.canAttest,
      }))
    } catch (e) {
      // The key is deliberately KEPT so the retry is the same logical turn, not a new one.
      setError(e.message || 'Something went wrong. Your answer was saved — please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm(action, paths, chosenValue) {
    setBusy(true); setError('')
    try {
      const res = await confirmValues({
        loanFileId, action, paths, chosenValue, locale,
        idempotencyKey: newIdempotencyKey(action),
      })
      setThread((p) => [...p, { role: 'assistant', question: res.nextQuestion }])
      setSession((s) => ({
        ...s, nextQuestion: res.nextQuestion, review: res.review,
        progress: res.progress, canAttest: res.canAttest,
      }))
    } catch (e) {
      setError(e.message || 'Could not save that.')
    } finally { setBusy(false) }
  }

  async function submitSecure(digits) {
    setSecureError('')
    try {
      const res = await saveSecureField({
        loanFileId, fieldPath: question.fieldPath, value: digits, locale,
        idempotencyKey: newIdempotencyKey('secure'),
      })
      setSession((s) => ({ ...s, nextQuestion: res.nextQuestion, progress: res.progress }))
      setThread((p) => [...p, { role: 'assistant', question: res.nextQuestion }])
      return true
    } catch (e) {
      setSecureError(e.status === 400 ? 'incomplete' : (e.message || 'Could not save that.'))
      return false
    }
  }

  if (!user) return <Alert kind="error">Please sign in to continue your application.</Alert>
  if (!session && !error) return <p className="muted">{t('loading', locale)}</p>

  const progress = session?.progress
  return (
    <div className="c1003" style={{ maxWidth: 680, margin: '0 auto' }}>
      <header className="c1003-head">
        <Link to="/portal" className="backlink">← {locale === 'es' ? 'Portal' : locale === 'ru' ? 'Портал' : 'Back to portal'}</Link>
        <h1>{t('title', locale)}</h1>
        <p className="muted">{t('intro', locale)}</p>

        {progress && (
          <div className="c1003-progress">
            <div className="c1003-bar" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              {t('progress', locale)}: {progress.percent}%
              {progress.openCount > 0 && ` · ${progress.openCount} left`}
            </p>
          </div>
        )}

      </header>

      <Alert kind="error">{error}</Alert>

      <div className="c1003-thread">
        {thread.map((entry, i) => (
          <ThreadEntry
            key={i} entry={entry} locale={locale}
            onConfirm={confirm} onAsk={(intent) => submit('', { intent })}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {question && <ActiveQuestion
        question={question} locale={locale} busy={busy}
        onAsk={(intent) => submit('', { intent })}
        onChoice={(value) => submit(value)}
        onResolveConflict={(value) => confirm('resolve_conflict', [question.fieldPath], value)}
      />}

      {question?.secureEntry ? (
        <SecureFieldInput
          fieldPath={question.fieldPath}
          type={question.dataType === 'ssn' ? 'ssn' : 'account'}
          locale={locale}
          busy={busy}
          error={secureError}
          onSubmit={submitSecure}
        />
      ) : question?.type !== 'review' && question?.type !== 'complete' && (
        <form className="c1003-composer" onSubmit={(e) => { e.preventDefault(); submit(text) }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('placeholder', locale)}
            rows={2}
            disabled={busy}
            aria-label={t('placeholder', locale)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(text) }
            }}
          />
          <div className="row">
            <button className="btn btn-primary" disabled={busy || !text.trim()}>
              {busy ? '…' : t('send', locale)}
            </button>
            <VoiceInput
              locale={locale}
              disabled={busy}
              secure={Boolean(question?.secureEntry)}
              onTranscript={(v) => submit(v, { inputMode: 'voice' })}
            />
          </div>
        </form>
      )}

      {session?.canAttest && (
        <AttestationPanel
          loanFileId={loanFileId}
          locale={locale}
          onAttested={(res) => setSession((s) => ({ ...s, ...res, canAttest: false }))}
        />
      )}

      <div className="c1003-review">
        <button type="button" className="btn btn-ghost" onClick={() => setShowReview((v) => !v)}>
          {showReview ? '▾' : '▸'} {t('reviewToggle', locale)}
        </button>
        {showReview && session?.review && (
          <ApplicationReview
            review={session.review}
            locale={locale}
            onCorrect={(path) => confirm('unsure', [path])}
          />
        )}
      </div>

      <p className="muted c1003-disclaimer">{t('notApproval', locale)}</p>
    </div>
  )
}

// ── Thread rendering ─────────────────────────────────────────────────────────

function ThreadEntry({ entry, locale, onConfirm }) {
  if (entry.role === 'borrower') {
    return <div className="c1003-msg c1003-msg--borrower">{entry.text}</div>
  }
  return (
    <div className="c1003-msg c1003-msg--assistant">
      {entry.degradedNotice && <p className="c1003-degraded">{entry.degradedNotice}</p>}

      {entry.message?.text && <p>{entry.message.text}</p>}

      {/* Captured facts appear immediately as chips — visible without interrupting. */}
      {entry.accepted?.length > 0 && (
        <ul className="c1003-chips">
          {entry.accepted.map((a) => (
            <li key={a.path} className={a.estimated ? 'chip chip--estimated' : 'chip'}>
              {a.displayValue}
            </li>
          ))}
        </ul>
      )}

      {entry.confirmation && (
        <div className="c1003-confirm">
          <p>{entry.confirmation.prompt}</p>
          <ul>
            {entry.confirmation.items.map((i) => (
              <li key={i.path}>
                <strong>{i.label}</strong>: {i.displayValue}
                {i.estimated && <em> (estimate)</em>}
              </li>
            ))}
          </ul>
          <div className="row">
            {entry.confirmation.options.map((o) => (
              <button
                key={o.id} type="button"
                className={o.id === 'correct' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => onConfirm(
                  o.id === 'correct' ? 'confirm' : o.id === 'unsure' ? 'unsure' : 'unsure',
                  entry.confirmation.items.map((i) => i.path),
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ActiveQuestion({ question, locale, busy, onAsk, onChoice, onResolveConflict }) {
  const [showWhy, setShowWhy] = useState(false)
  useEffect(() => { setShowWhy(false) }, [question?.id])

  if (question.type === 'review' || question.type === 'complete') return null

  return (
    <section className="c1003-question" aria-live="polite">
      <h2>{question.prompt}</h2>
      {showWhy && question.why && <p className="c1003-why">{question.why}</p>}

      {/* A contradiction is presented as a choice — the engine never picks for the borrower. */}
      {question.type === 'conflict' && (
        <div className="row">
          {question.choices.map((c) => (
            <button key={String(c.value)} type="button" className="btn btn-ghost" disabled={busy}
              onClick={() => onResolveConflict(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* Enum questions get real choices rather than making the borrower guess the wording. */}
      {question.type === 'field' && question.dataType === 'enum' && question.values && (
        <div className="row c1003-choices">
          {question.values.map((v) => (
            <button key={v} type="button" className="btn btn-ghost" disabled={busy} onClick={() => onChoice(v)}>
              {String(v).replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      )}
      {question.type === 'field' && question.dataType === 'boolean' && (
        <div className="row c1003-choices">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onChoice('yes')}>
            {locale === 'es' ? 'Sí' : locale === 'ru' ? 'Да' : 'Yes'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onChoice('no')}>
            {locale === 'es' ? 'No' : locale === 'ru' ? 'Нет' : 'No'}
          </button>
        </div>
      )}

      {/* The controls §11 requires on every question, always available. */}
      <div className="c1003-affordances">
        {(question.affordances || []).map((a) => (
          <button
            key={a.id} type="button" className="linklike" disabled={busy}
            onClick={() => (a.id === 'why_asking' ? setShowWhy((v) => !v) : onAsk(a.id))}
          >
            {a.label}
          </button>
        ))}
      </div>
    </section>
  )
}
