// Gate for authenticated routes. While the session resolves, show a spinner; if no
// session, bounce to /login preserving where the user was headed.
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Spinner } from './ui'

export default function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
  return children
}
