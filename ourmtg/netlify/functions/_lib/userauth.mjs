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

// Read claims only after GoTrue has verified the exact token in getUser(). This is not a
// signature verifier; it is a small, fail-closed decoder for a claim on an already-verified JWT.
export function claimsFromVerifiedJwt(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3 || !parts[1]) return {}
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {}
  } catch {
    return {}
  }
}

export function authenticatorAssuranceLevel(token) {
  return claimsFromVerifiedJwt(token).aal === 'aal2' ? 'aal2' : 'aal1'
}

// Client that acts AS the user — RLS enforced via the forwarded JWT.
export function userClient(token) {
  return createClient(URL, ANON, {
    global: { headers: { Authorization: 'Bearer ' + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Returns { user, token, aal } or null. Unknown/malformed assurance is always aal1.
export async function getUser(req) {
  if (!isConfigured()) return null
  const token = bearer(req)
  if (!token) return null
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) return null
  return { user: data.user, token, aal: authenticatorAssuranceLevel(token) }
}
