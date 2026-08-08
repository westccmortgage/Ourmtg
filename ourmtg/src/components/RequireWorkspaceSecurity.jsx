// Authenticated workspace gate. The server classifies the user from server-owned relationships:
// staff must present an AAL2 session when enforcement is enabled; borrowers and transaction
// partners continue with their normal verified session.
import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { getWorkspaceSecurityStatus } from '../lib/api'
import { Alert, Spinner } from './ui'

export default function RequireWorkspaceSecurity({ children }) {
  const { user, loading: authLoading } = useAuth()
  const location = useLocation()
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!user) return
    let active = true
    setStatus(null)
    setError('')
    getWorkspaceSecurityStatus()
      .then((next) => { if (active) setStatus(next) })
      .catch(() => { if (active) setError('We could not verify workspace security. Try again before opening the file.') })
    return () => { active = false }
  }, [user, attempt])

  if (authLoading) return <Spinner />
  const from = location.pathname + location.search
  if (!user) return <Navigate to="/login" state={{ from }} replace />
  if (error) {
    return (
      <div style={{ maxWidth: 520, margin: '32px auto' }}>
        <Alert kind="error">{error}</Alert>
        <button className="btn btn-primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
      </div>
    )
  }
  if (!status) return <Spinner />
  if (status.mfaRequired) return <Navigate to="/security" state={{ from }} replace />
  return children
}
