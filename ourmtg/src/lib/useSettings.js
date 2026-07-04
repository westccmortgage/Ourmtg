// Site settings: owner-editable config (live rate, loan programs, home marketing)
// read from the public site_settings row (migration 039). Public pages render before
// login, so this reads via the anon client + public-select RLS, with hardcoded
// defaults so the site is never blank if the row/DB is unavailable.
import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { isSupabaseConfigured } from './config'
import { LOAN_TYPES } from './leadFlows'

export const SETTINGS_DEFAULTS = {
  rate: 7,
  loanTypes: LOAN_TYPES,
  home: {
    headline: 'the mortgage,',
    headlineAlt: 'minus the noise.',
    sub: 'One secure link: upload documents from your phone, watch your loan move stage by stage, and always know what’s next — without a single “just checking in” call.',
  },
}

function merge(data) {
  const d = data || {}
  return {
    ...SETTINGS_DEFAULTS,
    ...d,
    loanTypes: Array.isArray(d.loanTypes) && d.loanTypes.length ? d.loanTypes : SETTINGS_DEFAULTS.loanTypes,
    home: { ...SETTINGS_DEFAULTS.home, ...(d.home || {}) },
  }
}

let _promise = null
// Fetch once and cache. `fresh` bypasses the cache (used by the settings editor).
export async function fetchSettings(fresh = false) {
  if (!isSupabaseConfigured()) return SETTINGS_DEFAULTS
  if (!fresh && _promise) return _promise
  const p = supabase()
    .from('site_settings').select('data').eq('id', 'default').maybeSingle()
    .then(({ data }) => merge(data?.data))
    .catch(() => SETTINGS_DEFAULTS)
  if (!fresh) _promise = p
  return p
}

export function useSettings() {
  const [s, setS] = useState(SETTINGS_DEFAULTS)
  useEffect(() => {
    let alive = true
    fetchSettings().then((v) => { if (alive) setS(v) })
    return () => { alive = false }
  }, [])
  return s
}
