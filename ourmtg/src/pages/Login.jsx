// Invite-aware sign-in. Google is the low-friction primary method when the provider rollout
// flag is on; a one-time email link remains the universal fallback. Both return to the exact
// local route the person was opening, and neither one grants access to a loan file by itself.
import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { GOOGLE_AUTH_ENABLED, isSupabaseConfigured } from '../lib/config'
import { absoluteAuthRedirect, safeAuthReturnPath } from '../lib/authRedirect'
import { useT } from '../lib/i18n'
import { Alert } from '../components/ui'

function GoogleMark() {
  return (
    <svg className="google-mark" aria-hidden="true" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.703-1.568 2.684-3.879 2.684-6.614Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.584-5.037-3.71H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.963 10.71A5.41 5.41 0 0 1 3.681 9c0-.593.102-1.17.282-1.71V4.958H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.042l3.007-2.332Z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.463.892 11.426 0 9 0A9 9 0 0 0 .956 4.958L3.963 7.29C4.672 5.164 6.656 3.58 9 3.58Z" />
    </svg>
  )
}

export default function Login() {
  const { signInWithGoogle, signInWithEmail, user } = useAuth()
  const location = useLocation()
  const t = useT()
  const from = safeAuthReturnPath(location.state?.from)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // google | email | ''

  // Already signed in → go where they were headed (e.g. back to an /invite link).
  if (user) return <Navigate to={from} replace />

  async function googleSignIn() {
    setError(''); setBusy('google')
    try {
      await signInWithGoogle(absoluteAuthRedirect(from, window.location.origin))
    } catch {
      setError(t('authGoogleError'))
      setBusy('')
    }
  }

  async function submit(e) {
    e.preventDefault()
    setError(''); setBusy('email')
    try {
      await signInWithEmail(email.trim(), absoluteAuthRedirect(from, window.location.origin))
      setSent(true)
    } catch (err) {
      setError(err?.message || t('authEmailError'))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="auth-page">
      <p className="eyebrow">{t('authEyebrow')}</p>
      <h1>{t('authTitle')}</h1>
      <p className="auth-intro">{t('authIntro')}</p>
      {!isSupabaseConfigured() && (
        <Alert kind="error">Sign-in isn’t configured yet (missing Supabase keys). Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</Alert>
      )}
      {sent ? (
        <div className="card auth-card">
          <h2>{t('authCheckTitle')}</h2>
          <p>{t('authCheckBody')} <strong>{email}</strong></p>
          <button className="btn btn-ghost btn-block" onClick={() => setSent(false)}>{t('authOtherEmail')}</button>
        </div>
      ) : (
        <div className="card auth-card">
          <Alert kind="error">{error}</Alert>
          {GOOGLE_AUTH_ENABLED && (
            <>
              <button type="button" className="btn btn-google btn-block btn-lg"
                disabled={!!busy || !isSupabaseConfigured()} onClick={googleSignIn}>
                <GoogleMark />
                {busy === 'google' ? t('authOpening') : t('authGoogle')}
              </button>
              <div className="auth-divider"><span>{t('authOr')}</span></div>
            </>
          )}
          <form onSubmit={submit}>
            <p className="muted mt0">{t('authEmailHelp')}</p>
            <div className="field">
              <label htmlFor="email">{t('authEmailLabel')}</label>
              <input id="email" type="email" required autoComplete="email" inputMode="email"
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <button className={`btn btn-block btn-lg ${GOOGLE_AUTH_ENABLED ? 'btn-ghost' : 'btn-primary'}`}
              disabled={!!busy || !isSupabaseConfigured()}>
              {busy === 'email' ? t('authSending') : t('authEmailCta')}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
