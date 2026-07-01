// Auth context: wraps the Supabase magic-link session and exposes { session, user,
// loading, signInWithEmail, signOut }. Magic-link only — no passwords (spec §O).
import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'
import { isSupabaseConfigured } from './config'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSupabaseConfigured()) { setLoading(false); return }
    let sub
    supabase().auth.getSession().then(({ data }) => {
      setSession(data?.session || null)
      setLoading(false)
    })
    sub = supabase().auth.onAuthStateChange((_e, s) => setSession(s)).data?.subscription
    return () => sub?.unsubscribe()
  }, [])

  const signInWithEmail = useCallback(async (email, redirectTo) => {
    const { error } = await supabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo || window.location.origin },
    })
    if (error) throw error
  }, [])

  const signOut = useCallback(async () => {
    try { await supabase().auth.signOut() } catch { /* ignore */ }
    setSession(null)
  }, [])

  return (
    <AuthCtx.Provider value={{ session, user: session?.user || null, loading, signInWithEmail, signOut }}>
      {children}
    </AuthCtx.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
