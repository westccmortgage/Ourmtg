// Magic-link sign-in (spec §K.2). Email only, no passwords. After entering an email we
// send a one-time link and tell the user to check their inbox. The redirect returns them
// to wherever they were headed (e.g. an /invite link).
import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/config'
import { Alert } from '../components/ui'

export default function Login() {
  const { signInWithEmail, user } = useAuth()
  const location = useLocation()
  const from = location.state?.from || '/portal'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Already signed in → go where they were headed (e.g. back to an /invite link).
  if (user) return <Navigate to={from} replace />

  async function submit(e) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      const redirectTo = `${window.location.origin}${from.startsWith('/') ? from : '/portal'}`
      await signInWithEmail(email.trim(), redirectTo)
      setSent(true)
    } catch (err) {
      setError(err?.message || 'Could not send your link. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '24px auto' }}>
      <h1>Sign in</h1>
      {!isSupabaseConfigured() && (
        <Alert kind="error">Sign-in isn’t configured yet (missing Supabase keys). Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</Alert>
      )}
      {sent ? (
        <div className="card">
          <h2>Check your email 📬</h2>
          <p>We sent a secure sign-in link to <strong>{email}</strong>. Open it on this device to continue — no password needed.</p>
          <button className="btn btn-ghost btn-block" onClick={() => setSent(false)}>Use a different email</button>
        </div>
      ) : (
        <form className="card" onSubmit={submit}>
          <p className="muted mt0">Enter your email and we’ll text-free email you a one-time link. No passwords, ever.</p>
          <Alert kind="error">{error}</Alert>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input id="email" type="email" required autoComplete="email" inputMode="email"
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <button className="btn btn-primary btn-block btn-lg" disabled={busy || !isSupabaseConfigured()}>
            {busy ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
      )}
    </div>
  )
}
