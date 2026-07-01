// Central client config, read from Vite env (VITE_*). Everything here is public by
// design — only the anon key and branding reach the browser. Never put the service
// role or any secret in a VITE_* var.

const env = import.meta.env

export const SUPABASE_URL = env.VITE_SUPABASE_URL || ''
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || ''

// Portal gateway base. Same-origin in production; overridable for `vite dev`.
// Lead submission goes through this same base (the lead-submit proxy function), so the
// GRCRM webhook token stays server-side and never ships in the browser bundle.
export const API_BASE = (env.VITE_API_BASE || '/.netlify/functions').replace(/\/$/, '')

export const BRAND = {
  company: env.VITE_COMPANY_NAME || 'West Coast Capital Mortgage',
  loName: env.VITE_LO_NAME || '',
  nmlsCompany: env.VITE_NMLS_COMPANY || '',
  nmlsLo: env.VITE_NMLS_LO || '',
}

export const isSupabaseConfigured = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY)
