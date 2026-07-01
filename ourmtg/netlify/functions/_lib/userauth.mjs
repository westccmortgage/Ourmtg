// Per-user auth for Netlify functions. Verifies the caller's Supabase JWT and builds
// a Supabase client scoped to that user so Row Level Security applies (no service_role).
import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

export function isConfigured() {
  return !!(URL && ANON)
}

function bearer(req) {
  const h = req.headers.get ? req.headers.get('authorization') : req.headers.authorization
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1] : null
}

// Client that acts AS the user — RLS enforced via the forwarded JWT.
export function userClient(token) {
  return createClient(URL, ANON, {
    global: { headers: { Authorization: 'Bearer ' + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Returns { user, token } or null.
export async function getUser(req) {
  if (!isConfigured()) return null
  const token = bearer(req)
  if (!token) return null
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) return null
  return { user: data.user, token }
}
