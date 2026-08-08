// Mandatory TOTP step-up for internal loan-team accounts. Borrowers never reach this screen from
// the workspace gate. Enrollment and verification use Supabase Auth directly; OurMTG never sees
// or stores the authenticator secret.
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { getWorkspaceSecurityStatus } from '../lib/api'
import { supabase } from '../lib/supabase'
import { Alert, Spinner } from '../components/ui'

function safeReturnPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !value.includes('\\') && !/%5c/i.test(value) && value !== '/security' ? value : '/portal'
}

export default function SecuritySetup() {
  const location = useLocation()
  const navigate = useNavigate()
  const returnTo = safeReturnPath(location.state?.from)
  const [loading, setLoading] = useState(true)
  const [internal, setInternal] = useState(null)
  const [verifiedFactor, setVerifiedFactor] = useState(null)
  const [allFactors, setAllFactors] = useState([])
  const [enrollment, setEnrollment] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [complete, setComplete] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const [workspace, assurance, factors] = await Promise.all([
          getWorkspaceSecurityStatus(),
          supabase().auth.mfa.getAuthenticatorAssuranceLevel(),
          supabase().auth.mfa.listFactors(),
        ])
        if (assurance.error) throw assurance.error
        if (factors.error) throw factors.error
        if (!active) return
        setInternal(workspace.internal === true)
        if (assurance.data?.currentLevel === 'aal2') {
          setComplete(true)
          return
        }
        const totp = factors.data?.totp || []
        setVerifiedFactor(totp[0] || null)
        setAllFactors(factors.data?.all || [])
      } catch (err) {
        if (active) setError(err?.message || 'Could not load multi-factor security.')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [attempt])

  async function beginEnrollment() {
    setBusy(true)
    setError('')
    try {
      // An interrupted enrollment has no recoverable QR secret. Remove only inactive TOTP
      // factors before issuing a fresh one; verified factors are never removed here.
      const stale = allFactors.filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified')
      for (const factor of stale) {
        const result = await supabase().auth.mfa.unenroll({ factorId: factor.id })
        if (result.error) throw result.error
      }
      const result = await supabase().auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'OurMTG loan team',
      })
      if (result.error) throw result.error
      setEnrollment(result.data)
      setAllFactors((current) => current.filter((factor) => factor.status === 'verified'))
    } catch (err) {
      setError(err?.message || 'Could not start authenticator setup.')
    } finally {
      setBusy(false)
    }
  }

  async function verify(e) {
    e.preventDefault()
    const factorId = enrollment?.id || verifiedFactor?.id
    if (!factorId || !/^\d{6}$/.test(code.trim())) return
    setBusy(true)
    setError('')
    try {
      const result = await supabase().auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
      if (result.error) throw result.error
      setComplete(true)
    } catch (err) {
      setError(err?.message || 'That code could not be verified. Try the current code from your app.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Spinner />
  if (complete) return <Navigate to={returnTo} replace />
  if (internal === false) return <Navigate to={returnTo} replace />
  if (error && internal === null) {
    return (
      <div style={{ maxWidth: 520, margin: '32px auto' }}>
        <Alert kind="error">{error}</Alert>
        <button className="btn btn-primary" onClick={() => {
          setLoading(true); setError(''); setAttempt((value) => value + 1)
        }}>Try again</button>
      </div>
    )
  }

  const factorId = enrollment?.id || verifiedFactor?.id
  return (
    <div style={{ maxWidth: 520, margin: '28px auto' }}>
      <p className="fileno">Internal workspace security</p>
      <h1>Verify it’s you</h1>
      <p className="muted">Loan-team accounts use an authenticator app before customer financial files open. Borrower accounts do not need this step.</p>
      <Alert kind="error">{error}</Alert>

      {!verifiedFactor && !enrollment && (
        <div className="card">
          <h2>Connect an authenticator</h2>
          <p>Use Google Authenticator, Microsoft Authenticator, 1Password, Authy, or another TOTP app.</p>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={beginEnrollment}>
            {busy ? 'Starting…' : 'Set up authenticator'}
          </button>
        </div>
      )}

      {enrollment?.totp && (
        <div className="card center">
          <h2>Scan this code</h2>
          <img src={enrollment.totp.qr_code} alt="Authenticator enrollment QR code"
            width="220" height="220" style={{ maxWidth: '100%', background: '#fff', padding: 8 }} />
          <p className="muted">Can’t scan it? Enter this setup key in your app:</p>
          <p style={{ fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}><strong>{enrollment.totp.secret}</strong></p>
        </div>
      )}

      {factorId && (
        <form className="card" onSubmit={verify}>
          <h2>{verifiedFactor ? 'Enter your current code' : 'Confirm setup'}</h2>
          <div className="field">
            <label htmlFor="mfa-code">6-digit authenticator code</label>
            <input id="mfa-code" type="text" inputMode="numeric" autoComplete="one-time-code"
              pattern="[0-9]{6}" maxLength="6" required autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify and open workspace'}
          </button>
        </form>
      )}
      <button className="btn btn-ghost btn-block" onClick={() => navigate('/')} disabled={busy}>Cancel</button>
    </div>
  )
}
