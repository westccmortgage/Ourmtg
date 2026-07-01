// Service-role Supabase client for server-side function use ONLY.
// Never expose SUPABASE_SERVICE_ROLE to the browser.
import { createClient } from '@supabase/supabase-js'

let _client = null

export function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE)
}

export function admin() {
  if (!isConfigured()) throw new Error('Supabase not configured (set SUPABASE_URL, SUPABASE_SERVICE_ROLE)')
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    })
  }
  return _client
}
