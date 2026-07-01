// Shared helpers for the OurMTG portal gateway functions (portal-*).
//
// AUTH MODEL
//   Portal users (borrower / co-borrower / realtor) authenticate with their own
//   Supabase JWT (magic link). We verify it with userauth.getUser (anon key), then
//   do all DB work with the SERVICE-ROLE client — but EVERY read/write is gated by an
//   explicit portal_access check in code (assertAccess). Portal users can therefore
//   only ever touch loan_files they were granted, and NEVER app_state.
//
// The LO/owner is also just an auth user; a caller whose id === loan_file.owner_user_id
// is the owner and gets the internal view without needing a portal_access grant.

import { admin } from './supabase.mjs'
import { getUser } from './userauth.mjs'

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } })

export const preflight = () => new Response('', { status: 204, headers: CORS })

// Client IP + UA for the audit log (best-effort; header names vary by platform).
export function ipOf(req) {
  const h = (n) => (req.headers.get ? req.headers.get(n) : req.headers[n]) || ''
  return (h('x-nf-client-connection-ip') || h('x-forwarded-for').split(',')[0] || '').trim() || null
}
export function uaOf(req) {
  const h = (n) => (req.headers.get ? req.headers.get(n) : req.headers[n]) || ''
  return h('user-agent').slice(0, 400) || null
}

// Verify the caller's JWT. Returns { user, token } or null. (Thin re-export so portal
// functions don't each import userauth directly.)
export async function authUser(req) {
  return getUser(req)
}

// Load a loan_file by id (service role). Returns the row or null.
export async function loadLoanFile(svc, loanFileId) {
  if (!loanFileId) return null
  const { data, error } = await svc
    .from('loan_files')
    .select('*')
    .eq('id', loanFileId)
    .maybeSingle()
  if (error) throw new Error('loan_file read: ' + error.message)
  return data || null
}

// Resolve the caller's relationship to a loan file.
//   Returns { role, visibility, loanFile } where:
//     role       = 'owner' | 'portal'
//     visibility = 'owner' | 'borrower' | 'coborrower' | 'realtor'
//   or null if the caller has NO access to this file.
//
// Owner short-circuit: caller.id === loan_file.owner_user_id → full internal access.
// Otherwise a portal_access row must exist; its `visibility` is returned.
export async function resolveAccess(svc, userId, loanFile) {
  if (!loanFile) return null
  if (userId === loanFile.owner_user_id) {
    return { role: 'owner', visibility: 'owner', loanFile }
  }
  const { data, error } = await svc
    .from('portal_access')
    .select('visibility')
    .eq('portal_user', userId)
    .eq('loan_file_id', loanFile.id)
    .maybeSingle()
  if (error) throw new Error('portal_access read: ' + error.message)
  if (!data) return null
  return { role: 'portal', visibility: data.visibility, loanFile }
}

// True when a visibility level is allowed to touch borrower financial data
// (documents, conditions, full status). Realtors are always excluded.
export function canSeeFinancials(visibility) {
  return visibility === 'owner' || visibility === 'borrower' || visibility === 'coborrower'
}

// Append an audit row. Never throws (audit must not break the action).
export async function logAccess(svc, { portalUser, loanFileId, action, target, req }) {
  try {
    await svc.from('portal_access_log').insert({
      portal_user: portalUser || null,
      loan_file_id: loanFileId || null,
      action,
      target: target || null,
      ip: req ? ipOf(req) : null,
    })
  } catch (e) {
    console.warn('[portal] logAccess failed (non-fatal):', e?.message || e)
  }
}

// ── Pipeline stage → borrower/realtor-facing labels ───────────────────────────
// Mirrors src/lib/pipeline.js STAGES. `step` is the 0-based index for a 7-step bar.
export const STAGE_META = {
  lead:         { step: 0, label: 'Application',    borrower: "Finish your application and upload your documents so we can review.", realtor: 'Application started' },
  preapproval:  { step: 1, label: 'Pre-Approval',   borrower: "You're pre-approved. Let's move toward your home and next steps.",    realtor: 'Pre-approved' },
  processing:   { step: 2, label: 'Processing',     borrower: "We're processing your file and verifying your documents.",            realtor: 'In processing' },
  underwriting: { step: 3, label: 'Underwriting',   borrower: 'Your loan is in underwriting — the detailed review stage.',           realtor: 'In underwriting' },
  conditional:  { step: 4, label: 'Conditional',    borrower: 'Approved with conditions — a few items left to clear.',               realtor: 'In underwriting' },
  ctc:          { step: 5, label: 'Clear to Close', borrower: "Clear to close! We'll coordinate your signing details.",              realtor: 'Clear to close' },
  funded:       { step: 6, label: 'Funded',         borrower: 'Your loan funded. Congratulations!',                                  realtor: 'Funded' },
}
export const STAGE_STEPS = ['lead', 'preapproval', 'processing', 'underwriting', 'conditional', 'ctc', 'funded']

export function stageInfo(stage) {
  return STAGE_META[stage] || STAGE_META.lead
}

// Server-generated hex token. `bytes` → 2*bytes hex chars.
export async function randomToken(bytes = 16) {
  const { randomBytes } = await import('node:crypto')
  return randomBytes(bytes).toString('hex')
}
