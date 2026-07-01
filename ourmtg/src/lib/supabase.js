// Browser Supabase client (anon key). Used for:
//   • magic-link auth (signInWithOtp / getSession / onAuthStateChange)
//   • RLS-scoped direct reads the gateway doesn't expose (loan_conditions,
//     loan_messages, portal_access) — RLS restricts every row to the caller
//   • uploading a document to a server-minted signed URL (uploadToSignedUrl)
//
// It is NEVER used to read loan_files directly for realtors (that would leak the loan
// amount past the column-scoping the gateway enforces) — status always goes through the
// portal-status function.
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './config'

let _client = null

export function supabase() {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  }
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  }
  return _client
}
