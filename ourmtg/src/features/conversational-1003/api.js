// Conversational 1003 — browser API client.
//
// Thin wrappers over the application-* gateway functions, reusing the app's existing auth
// pattern (Bearer JWT forwarded, server enforces access). Nothing here decides anything: the
// next question, progress, and completeness all come from the server.
//
// Idempotency keys are generated HERE and reused across retries of the same logical action —
// that is what makes a double-tap or a flaky connection safe (§24).

import { supabase } from '../../lib/supabase'
import { API_BASE } from '../../lib/config'

export class ApplicationApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'ApplicationApiError'
    this.status = status
    this.payload = payload || null
  }
}

async function authHeader() {
  const { data } = await supabase().auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new ApplicationApiError('Please sign in again.', 401)
  return { Authorization: `Bearer ${token}` }
}

async function call(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json', ...(await authHeader()) }
  let res
  try {
    res = await fetch(`${API_BASE}/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApplicationApiError('Network error — check your connection and try again.', 0)
  }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    throw new ApplicationApiError(data?.error || `Request failed (${res.status})`, res.status, data)
  }
  return data
}

/** Stable per-action key. Callers keep it across retries of the SAME action. */
export function newIdempotencyKey(prefix = 'c1003') {
  const rand = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return `${prefix}.${rand}`.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 200)
}

// `assistParty` is only meaningful for the loan team: it says whose seat they are filling. The
// server ignores it for a borrower, who can only ever be answering for themselves.
export const getSession = (loanFileId, locale = 'en', assistParty = null) =>
  call(`application-session?loanFileId=${encodeURIComponent(loanFileId)}&locale=${encodeURIComponent(locale)}`
    + (assistParty === 0 || assistParty === 1 ? `&assistParty=${assistParty}` : ''))

export const sendTurn = ({ loanFileId, text, intent = 'answer', locale = 'en', inputMode = 'text', askedQuestionId, askedFieldPath, idempotencyKey, assistParty, takenVia }) =>
  call('application-turn', {
    method: 'POST',
    body: {
      loanFileId, text, intent, locale, inputMode, askedQuestionId, askedFieldPath, idempotencyKey,
      ...(assistParty === 0 || assistParty === 1 ? { assistParty, takenVia } : {}),
    },
  })

export const confirmValues = ({ loanFileId, action, paths, fieldPath, chosenValue, locale = 'en', idempotencyKey, assistParty, takenVia }) =>
  call('application-confirm', {
    method: 'POST',
    body: {
      loanFileId, action, paths, fieldPath, chosenValue, locale, idempotencyKey,
      ...(assistParty === 0 || assistParty === 1 ? { assistParty, takenVia } : {}),
    },
  })

export const saveSecureField = ({ loanFileId, fieldPath, value, locale = 'en', idempotencyKey }) =>
  call('application-secure-field', {
    method: 'POST',
    body: { loanFileId, fieldPath, value, locale, idempotencyKey },
  })

export const attest = ({ loanFileId, documentVersion, presentedAt, locale = 'en', idempotencyKey }) =>
  call('application-attest', {
    method: 'POST',
    body: { loanFileId, documentVersion, presentedAt, accepted: true, locale, idempotencyKey },
  })

export const getTeamReview = (loanFileId) =>
  call(`application-team-review?loanFileId=${encodeURIComponent(loanFileId)}`)

export const teamAction = ({ loanFileId, action, fieldPath, value, note, idempotencyKey }) =>
  call('application-team-review', {
    method: 'POST',
    body: { loanFileId, action, fieldPath, value, note, idempotencyKey },
  })
