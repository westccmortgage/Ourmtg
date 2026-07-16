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

// Sensitive API responses must never be cached by browsers/proxies (Phase 1A §10).
export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  })

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
//   Returns { role, visibility, loanFile, teamRole? } where:
//     role       = 'owner' | 'team' | 'portal'
//     visibility = 'owner' | 'borrower' | 'coborrower' | 'realtor' | 'escrow' | 'title'
//   or null if the caller has NO access to this file.
//
// Owner short-circuit: caller.id === loan_file.owner_user_id → full internal access.
// Team short-circuit: a portal_team row (member of this file's owner) → same internal
// access (visibility 'owner'), so processors/assistants work the file like the LO.
// Otherwise a portal_access row must exist; its `visibility` is returned.
export async function resolveAccess(svc, userId, loanFile) {
  if (!loanFile) return null
  if (userId === loanFile.owner_user_id) {
    return { role: 'owner', visibility: 'owner', loanFile }
  }
  const { data: team, error: tErr } = await svc
    .from('portal_team')
    .select('role')
    .eq('member_user_id', userId)
    .eq('owner_user_id', loanFile.owner_user_id)
    .maybeSingle()
  if (tErr && tErr.code !== '42P01') throw new Error('portal_team read: ' + tErr.message)
  // 42P01 = table missing (migration 038 not applied yet) — degrade to pre-team behavior.
  if (team) {
    return { role: 'team', visibility: 'owner', teamRole: team.role, loanFile }
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

// True when the caller works the file from the inside (LO/owner or their team) —
// gates review, invites, pre-approval, doc requests, condition management.
export function isInternal(access) {
  return !!access && (access.role === 'owner' || access.role === 'team')
}

// True when a visibility level is allowed to touch borrower financial data
// (documents, conditions, full status). Realtors/escrow/title are always excluded.
export function canSeeFinancials(visibility) {
  return visibility === 'owner' || visibility === 'borrower' || visibility === 'coborrower'
}

// ── Platform administration (site-wide settings) ──────────────────────────────
// Global site settings (live rate, loan programs, home marketing copy) affect EVERY
// public visitor, so writing them is a PLATFORM-ADMIN action — deliberately distinct
// from per-file loan access. Owner decision (Phase 1A #1): loan ownership, including a
// self-provisioned file, must NEVER confer platform-admin authority. Authorization is
// therefore an explicit allowlist only: OURMTG_ADMIN_EMAILS.

// Parse a comma-separated admin-email allowlist into normalized (trimmed, lowercased)
// entries. Pure — safe to unit-test.
export function parseAdminEmails(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

// True IFF `email` is in the configured OURMTG_ADMIN_EMAILS allowlist. An empty/unset
// allowlist grants NO ONE (fail-closed) — there is no ownership fallback. Pure.
export function isSettingsAdmin(email, adminEmailsRaw) {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return false
  return parseAdminEmails(adminEmailsRaw).includes(e)
}

// Build the SERVER-CONTROLLED storage object path for a borrower document. The path is
// ALWAYS rooted at <owner>/<loanFile>/… so a caller can never write into another file or
// owner's namespace. docKey is sanitized to a safe charset (defense-in-depth against path
// traversal even though docKey is already allowlisted upstream). Pure — unit-tested.
export function storageDocPath(ownerUserId, loanFileId, docKey, rand) {
  const safeKey = String(docKey || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'doc'
  return `${ownerUserId}/${loanFileId}/${safeKey}-${rand}`
}

// Email addresses of the borrower/co-borrower portal users on a loan file — the
// standard "notify the borrower side" recipient list (fail-soft callers).
export async function borrowerEmails(svc, loanFileId) {
  const { data: grants } = await svc
    .from('portal_access')
    .select('portal_user')
    .eq('loan_file_id', loanFileId)
    .in('visibility', ['borrower', 'coborrower'])
  const ids = (grants || []).map((g) => g.portal_user)
  if (!ids.length) return []
  const { data: people } = await svc.from('portal_users').select('email').in('id', ids)
  return (people || []).map((p) => p.email).filter(Boolean)
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
