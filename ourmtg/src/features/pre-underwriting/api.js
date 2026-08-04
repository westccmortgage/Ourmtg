// Autopilot Pre-Underwriting — browser API client.
//
// Same shape as the conversational 1003's client: thin wrappers, auth forwarded, the server
// decides everything. Nothing here computes a readiness figure, a program list, or a finding —
// those arrive already computed so the screen and the tests cannot disagree.

import { supabase } from '../../lib/supabase'
import { API_BASE } from '../../lib/config'

export class PreUnderwritingError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'PreUnderwritingError'
    this.status = status
    this.payload = payload || null
    this.code = payload?.code || null
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const { data } = await supabase().auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new PreUnderwritingError('Please sign in again.', 401)

  let res
  try {
    res = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new PreUnderwritingError('Network error — check your connection and try again.', 0)
  }
  let payload = null
  try { payload = await res.json() } catch { /* non-JSON */ }
  if (!res.ok || (payload && payload.ok === false)) {
    throw new PreUnderwritingError(payload?.error || `Request failed (${res.status})`, res.status, payload)
  }
  return payload
}

export function newKey(prefix = 'pu') {
  const rand = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}.${rand}`.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 200)
}

export const getPanel = (loanFileId) =>
  call(`pre-underwriting-review?loanFileId=${encodeURIComponent(loanFileId)}`)

export const readDocument = (loanFileId, documentId) =>
  call('pre-underwriting-intake', {
    method: 'POST',
    body: { loanFileId, documentId, idempotencyKey: newKey('read') },
  })

export const resolveFinding = ({ loanFileId, findingId, action, note, correctedFields }) =>
  call('pre-underwriting-review', {
    method: 'POST',
    body: { loanFileId, findingId, action, note, correctedFields, idempotencyKey: newKey(action) },
  })

export const reanalyse = (loanFileId) =>
  call('pre-underwriting-review', {
    method: 'POST',
    body: { loanFileId, action: 'reanalyse', idempotencyKey: newKey('reanalyse') },
  })

export const importLiabilities = (loanFileId) =>
  call('pre-underwriting-review', {
    method: 'POST',
    body: { loanFileId, action: 'import_liabilities', idempotencyKey: newKey('import') },
  })

export const getCreditAuthorization = (loanFileId) =>
  call(`credit-authorization?loanFileId=${encodeURIComponent(loanFileId)}`)

export const authorizeCredit = ({ loanFileId, documentVersion, presentedAt }) =>
  call('credit-authorization', {
    method: 'POST',
    body: { loanFileId, documentVersion, presentedAt, accepted: true, idempotencyKey: newKey('credit') },
  })
