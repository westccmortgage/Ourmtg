// Conversational 1003 — the borrower workspace (§18).
//
// Mobile-first. One question at a time, the borrower's captured facts visible as editable
// chips, and the conversation as the primary interface — there is no long form hiding behind
// this screen.
//
// Everything shown here comes from the server: the next question, progress, and completeness
// are computed by the deterministic engine, not by this component.
//
// ── assist mode ─────────────────────────────────────────────────────────────
// The same screen, driven by the loan team with the borrower on the phone. It is the identical
// interview because it must be: two question orders would be two applications. What changes is
// only what is true about who is answering —
//
//   • the answers are recorded as `team_entry`, not as the borrower's own words
//   • the header never stops saying whose application this is
//   • SSNs and account numbers are not offered: a value that exists to never travel through a
//     chat box does not become safe because a loan officer is the one typing it
//   • attestation is absent, not disabled — the borrower signs, and they sign after this
//
// The wording throughout addresses the person taking the application, not the borrower. A
// screen that says "your income" to someone entering somebody else's is how a file gets
// misattributed by an honest person in a hurry.

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
import CreditAuthorization from '../../pre-underwriting/components/CreditAuthorization'
import { preUnderwritingEnabled } from '../../pre-underwriting/clientFlag'

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

export default function ApplicationAssistant({ assist = false }) {
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
  // Assist mode does not begin until both are answered. Neither is inferable and a wrong guess
  // writes a false record, so the interview does not start on a default.
  const [assistParty, setAssistParty] = useState(null)
  const [takenVia, setTakenVia] = useState(null)
  const bottomRef = useRef(null)

  const assisting = assist && assistParty !== null && takenVia !== null
  // Passed on every write. Undefined for a borrower, who can only be answering for themselves.
  const onBehalf = assisting ? { assistParty, takenVia } : {}

  // One key per pending submission, held across retries so a resend can never double-write.
  const pendingKey = useRef(null)

  const load = useCallback(async () => {
    try {
      const s = await getSession(loanFileId, locale, assisting ? assistParty : null)
      setSession(s)
      if (s.nextQuestion) {
        setThread((prev) => (prev.length ? prev : [{ role: 'assistant', question: s.nextQuestion }]))
      }
    } catch (e) {
      setError(e.message || 'Could not load your application.')
    }
  }, [loanFileId, locale, assisting, assistParty])

  useEffect(() => { if (!assist || assisting) load() }, [load, assist, assisting])
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
        ...onBehalf,
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
        ...onBehalf,
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
  if (assist && !assisting) {
    return (
      <AssistGate
        loanFileId={loanFileId}
        onStart={(party, via) => { setAssistParty(party); setTakenVia(via) }}
      />
    )
  }
  if (!session && !error) return <p className="muted">{t('loading', locale)}</p>

  const progress = session?.progress
  return (
    <div className="c1003" style={{ maxWidth: 680, margin: '0 auto' }}>
      <header className="c1003-head">
        {assisting ? (
          <Link to={`/portal/file/${loanFileId}/application`} className="backlink">← Back to the file</Link>
        ) : (
          <Link to="/portal" className="backlink">← {locale === 'es' ? 'Portal' : locale === 'ru' ? 'Портал' : 'Back to portal'}</Link>
        )}
        <h1>{assisting ? 'Taking the application' : t('title', locale)}</h1>
        {assisting ? (
          <AssistBanner
            session={session}
            takenVia={takenVia}
            partyIndex={assistParty}
          />
        ) : (
          <p className="muted">{t('intro', locale)}</p>
        )}

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

      {question?.secureEntry && assisting ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <b>This one only {borrowerLabel(session)} can enter.</b> A Social Security or account
            number is never typed into a conversation — it goes into a separate secure control on
            their own screen, and reading it to you over the phone would defeat that.
          </p>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy}
            onClick={() => submit('', { intent: 'skip_for_now' })}>
            Skip this — they’ll enter it
          </button>
        </div>
      ) : question?.secureEntry ? (
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

      {assisting && session?.progress?.openCount === 0 && <AssistHandoff loanFileId={loanFileId} session={session} />}

      {/* Credit permission. Borrower side only — the component returns null for the team, and
          the endpoint refuses them outright. Placed before attestation because the credit pull
          usually happens while the application is still being finished, not after it. */}
      {!assisting && preUnderwritingEnabled() && (
        <CreditAuthorization loanFileId={loanFileId} locale={locale} />
      )}

      {!assisting && session?.canAttest && (
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

// ── assist mode ──────────────────────────────────────────────────────────────

const VIA_LABEL = { phone: 'over the phone', in_person: 'in person', video: 'on a video call' }

const borrowerLabel = (session) => session?.assisting?.borrowerName || 'the borrower'

// Two questions, asked once, before a single answer is recorded. They are not settings — they
// are the two facts that make every row written afterwards true, and the URLA has a box for the
// second one.
function AssistGate({ loanFileId, onStart }) {
  const [party, setParty] = useState(0)
  const [via, setVia] = useState('phone')
  return (
    <div style={{ maxWidth: 560, margin: '8px auto' }}>
      <Link to={`/portal/file/${loanFileId}/application`} className="backlink">← Back to the file</Link>
      <h1 style={{ marginBottom: 6 }}>Take this application</h1>
      <p className="muted" style={{ marginBottom: 22 }}>
        The same interview the borrower would get, with you typing what they tell you. Everything
        you enter is recorded as taken by you — not as their own words — so the file stays honest
        about where each answer came from.
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="ag-party">Who are you entering this for?</label>
          <select id="ag-party" value={party} onChange={(e) => setParty(Number(e.target.value))}>
            <option value={0}>The borrower</option>
            <option value={1}>The co-borrower</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ag-via">How are you taking it?</label>
          <select id="ag-via" value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="phone">Over the phone</option>
            <option value="in_person">In person</option>
            <option value="video">On a video call</option>
          </select>
          <p className="hint">Recorded with the application, the way the 1003 asks for it.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => onStart(party, via)}>
          Start
        </button>
      </div>

      <p className="hint" style={{ marginTop: 18 }}>
        Two things you will not be able to do, by design: enter their Social Security or account
        numbers, and sign for them. Both are theirs. When you are done, send them the link — they
        review what you recorded and submit it.
      </p>
    </div>
  )
}

// Stays on screen for the whole interview. A team member who forgets whose application this is
// for even one question is how a file ends up misattributed by someone acting in good faith.
function AssistBanner({ session, takenVia, partyIndex }) {
  const who = session?.assisting?.borrowerName
  const role = partyIndex === 1 ? 'co-borrower' : 'borrower'
  return (
    <div className="c1003-assist-banner">
      <p className="mb0">
        <b>You are entering this for {who ? `${who} (${role})` : `the ${role}`}</b>{' '}
        {VIA_LABEL[takenVia] || ''}. Answers are saved as recorded by you.
      </p>
    </div>
  )
}

// The end of a team-taken application is not a submission — it is a handoff. Saying so here
// stops the obvious wrong conclusion: that filling everything in finished the job.
function AssistHandoff({ loanFileId, session }) {
  return (
    <div className="card">
      <div className="card-head"><h2>Everything is recorded</h2></div>
      <p style={{ marginTop: 0 }}>
        Nothing is submitted yet, and it should not be — {borrowerLabel(session)} has to review
        what you entered and submit it themselves. Send them their link; they will see the same
        answers and a plain statement of what they are confirming.
      </p>
      <Link to={`/portal/file/${loanFileId}`} className="btn btn-primary btn-sm">
        Open the file to send their link
      </Link>
    </div>
  )
}
