// Typed-ish wrappers around the OurMTG portal gateway (netlify/functions/portal-*).
// Every call forwards the caller's Supabase JWT as a Bearer token; the function verifies
// it, then enforces portal_access in code. All financial reads go through here (never a
// direct client query) so the server's column-scoping stays authoritative.
import { supabase } from './supabase'
import { API_BASE } from './config'

async function authHeader() {
  const { data } = await supabase().auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new ApiError('Please sign in again.', 401)
  return { Authorization: `Bearer ${token}` }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (auth) Object.assign(headers, await authHeader())
  let res
  try {
    res = await fetch(`${API_BASE}/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Network error — check your connection and try again.', 0)
  }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status)
  }
  return data
}

// ── Portal user (borrower / co-borrower / realtor) ───────────────────────────
export const acceptInvite = (token) =>
  call('portal-invite-accept', { method: 'POST', body: { token } })

export const getStatus = (loanFileId) =>
  call(`portal-status?loanFileId=${encodeURIComponent(loanFileId)}`)

export const getChecklist = (loanFileId) =>
  call(`portal-checklist?loanFileId=${encodeURIComponent(loanFileId)}`)

export const getUploadUrl = (loanFileId, docKey, options = {}) =>
  call('portal-doc-upload-url', { method: 'POST', body: { loanFileId, docKey, ...options } })

export const completeUpload = (documentId, taskContext = null) =>
  call('portal-doc-complete', {
    method: 'POST',
    body: {
      documentId,
      ...(taskContext ? {
        taskId: taskContext.taskId,
        expectedRevision: taskContext.expectedRevision,
        idempotencyKey: taskContext.idempotencyKey,
      } : {}),
    },
  })

// ── Loan officer / owner ─────────────────────────────────────────────────────
export const getReviewQueue = () => call('portal-review-queue')

export const getFileDetail = (loanFileId) =>
  call(`portal-file-detail?loanFileId=${encodeURIComponent(loanFileId)}`)

export const reviewDoc = (documentId, decision, rejectReason) =>
  call('portal-doc-review', { method: 'POST', body: { documentId, decision, rejectReason } })

export const setPreapproval = (loanFileId, amount, expires) =>
  call('portal-preapproval-set', { method: 'POST', body: { loanFileId, amount, expires } })

export const createInvite = (payload) =>
  call('portal-invite-create', { method: 'POST', body: payload })

export const requestDoc = (loanFileId, label, who) =>
  call('portal-doc-request', { method: 'POST', body: { loanFileId, label, who } })

export const setCondition = (payload) =>
  call('portal-condition-set', { method: 'POST', body: payload })

export const sendMessage = (loanFileId, body) =>
  call('portal-message-send', { method: 'POST', body: { loanFileId, body } })

export const setLoanFile = (payload) =>
  call('portal-loanfile-set', { method: 'POST', body: payload })

export const teamList = () => call('portal-team-set')
export const teamAdd = (email, role) =>
  call('portal-team-set', { method: 'POST', body: { action: 'add', email, role } })
export const teamRemove = (memberUserId) =>
  call('portal-team-set', { method: 'POST', body: { action: 'remove', memberUserId } })

// Site settings (owner/admin) — live rate, loan programs, home marketing.
export const saveSettings = (data) =>
  call('portal-settings-set', { method: 'POST', body: { data } })

// ── Task pilot (Phase 1C) ────────────────────────────────────────────────────
export const listTasks = (loanFileId) =>
  call(`portal-task-list?loanFileId=${encodeURIComponent(loanFileId)}`)
export const getTaskDetail = (taskId) =>
  call(`portal-task-detail?taskId=${encodeURIComponent(taskId)}`)
export const createTask = (payload) =>
  call('portal-task-create', { method: 'POST', body: payload })
export const transitionTask = (taskId, action, extra = {}) =>
  call('portal-task-transition', { method: 'POST', body: { taskId, action, ...extra } })

// ── Direct RLS reads the gateway doesn't expose (borrower/co-borrower only) ───
// portal_access is readable by the user (own-grants RLS policy) — this is how the app
// discovers which loan files to show and at what visibility.
export async function listMyGrants() {
  const { data, error } = await supabase()
    .from('portal_access')
    .select('loan_file_id, visibility, created_at')
    .order('created_at', { ascending: false })
  if (error) throw new ApiError(error.message, 500)
  return data || []
}

// loan_conditions RLS restricts to borrower/co-borrower of the file — realtors get none.
export async function listConditions(loanFileId) {
  const { data, error } = await supabase()
    .from('loan_conditions')
    .select('id, title, detail, status, created_at, updated_at')
    .eq('loan_file_id', loanFileId)
    .order('created_at', { ascending: true })
  if (error) throw new ApiError(error.message, 500)
  return data || []
}

// loan_messages RLS lets any grantee of the file read the timeline.
export async function listMessages(loanFileId) {
  const { data, error } = await supabase()
    .from('loan_messages')
    .select('id, direction, author_role, body, channel, created_at')
    .eq('loan_file_id', loanFileId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw new ApiError(error.message, 500)
  return data || []
}

// ── Upload a file to a server-minted signed URL, then finalize ───────────────
export async function uploadDocument(loanFileId, docKey, file, taskContext = null) {
  const signed = await getUploadUrl(loanFileId, docKey, {
    contentType: file.type || null,
    filename: file.name || null,
    ...(taskContext ? { taskId: taskContext.taskId, documentId: taskContext.requiredDocumentId } : {}),
  })
  if (taskContext?.requiredDocumentId && signed.documentId !== taskContext.requiredDocumentId) {
    throw new ApiError('This upload does not match the requested task document.', 409)
  }
  const { error } = await supabase()
    .storage.from(signed.bucket)
    .uploadToSignedUrl(signed.path, signed.token, file)
  if (error) throw new ApiError(error.message || 'Upload failed', 500)
  return completeUpload(signed.documentId, taskContext ? {
    taskId: taskContext.taskId,
    expectedRevision: taskContext.expectedRevision,
    idempotencyKey: taskContext.idempotencyKey,
  } : null)
}

// ── Lead intake (borrower application + realtor buyer submit) ─────────────────
// Posts the shared lead shape to the lead-submit proxy (same origin, no auth), which
// forwards it to GRCRM's lead-inbound webhook with the source token kept server-side.
export const submitLead = (payload) =>
  call('lead-submit', { method: 'POST', body: payload, auth: false })
