// Typed-ish wrappers around the OurMTG portal gateway.
import { supabase } from './supabase'
import { API_BASE } from './config'

async function authHeader() {
  const { data } = await supabase().auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new ApiError('Please sign in again.', 401)
  return { Authorization: `Bearer ${token}` }
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status }
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (auth) Object.assign(headers, await authHeader())
  let res
  try { res = await fetch(`${API_BASE}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }) }
  catch { throw new ApiError('Network error — check your connection and try again.', 0) }
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok || (data && data.ok === false)) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status)
  return data
}

export const acceptInvite = (token) => call('portal-invite-accept', { method: 'POST', body: { token } })
export const getStatus = (loanFileId) => call(`portal-status?loanFileId=${encodeURIComponent(loanFileId)}`)
export const getChecklist = (loanFileId) => call(`portal-checklist?loanFileId=${encodeURIComponent(loanFileId)}`)
export const getUploadUrl = (loanFileId, docKey, options = {}) => call('portal-doc-upload-url', {
  method: 'POST',
  body: { loanFileId, docKey, ...options },
})
export const completeUpload = (documentId, taskContext = null) => call('portal-doc-complete', {
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

export const getReviewQueue = () => call('portal-review-queue')
export const getFileDetail = (loanFileId) => call(`portal-file-detail?loanFileId=${encodeURIComponent(loanFileId)}`)
export const reviewDoc = (documentId, decision, rejectReason) => call('portal-doc-review', { method: 'POST', body: { documentId, decision, rejectReason } })
export const setPreapproval = (loanFileId, amount, expires) => call('portal-preapproval-set', { method: 'POST', body: { loanFileId, amount, expires } })
export const createInvite = (payload) => call('portal-invite-create', { method: 'POST', body: payload })
export const requestDoc = (loanFileId, label, who) => call('portal-doc-request', { method: 'POST', body: { loanFileId, label, who } })
export const setCondition = (payload) => call('portal-condition-set', { method: 'POST', body: payload })
export const sendMessage = (loanFileId, body) => call('portal-message-send', { method: 'POST', body: { loanFileId, body } })
export const setLoanFile = (payload) => call('portal-loanfile-set', { method: 'POST', body: payload })
export const teamList = () => call('portal-team-set')
export const teamAdd = (email, role) => call('portal-team-set', { method: 'POST', body: { action: 'add', email, role } })
export const teamRemove = (memberUserId) => call('portal-team-set', { method: 'POST', body: { action: 'remove', memberUserId } })
export const saveSettings = (data) => call('portal-settings-set', { method: 'POST', body: { data } })

export const listTasks = (loanFileId) => call(`portal-task-list?loanFileId=${encodeURIComponent(loanFileId)}`)
export const getTaskDetail = (taskId) => call(`portal-task-detail?taskId=${encodeURIComponent(taskId)}`)
export const createTask = (payload) => call('portal-task-create', { method: 'POST', body: payload })
export const transitionTask = (taskId, action, extra = {}) => call('portal-task-transition', { method: 'POST', body: { taskId, action, ...extra } })

export async function listMyGrants() {
  const { data, error } = await supabase().from('portal_access')
    .select('loan_file_id, visibility, created_at').order('created_at', { ascending: false })
  if (error) throw new ApiError(error.message, 500)
  return data || []
}

export async function listConditions(loanFileId) {
  const { data, error } = await supabase().from('loan_conditions')
    .select('id, title, detail, status, created_at, updated_at')
    .eq('loan_file_id', loanFileId).order('created_at', { ascending: true })
  if (error) throw new ApiError(error.message, 500)
  return data || []
}

export async function listMessages(loanFileId) {
  const { data, error } = await supabase().from('loan_messages')
    .select('id, direction, author_role, body, channel, created_at')
    .eq('loan_file_id', loanFileId).order('created_at', { ascending: false }).limit(50)
  if (error) throw new ApiError(error.message, 500)
  return data || []
}

export async function uploadDocument(loanFileId, docKey, file, taskContext = null) {
  const signed = await getUploadUrl(loanFileId, docKey, {
    contentType: file.type || null,
    filename: file.name || null,
    ...(taskContext ? { taskId: taskContext.taskId, documentId: taskContext.requiredDocumentId } : {}),
  })
  if (taskContext?.requiredDocumentId && signed.documentId !== taskContext.requiredDocumentId) {
    throw new ApiError('This upload does not match the requested task document.', 409)
  }
  const { error } = await supabase().storage.from(signed.bucket)
    .uploadToSignedUrl(signed.path, signed.token, file)
  if (error) throw new ApiError(error.message || 'Upload failed', 500)
  return completeUpload(signed.documentId, taskContext ? {
    taskId: taskContext.taskId,
    expectedRevision: taskContext.expectedRevision,
    idempotencyKey: taskContext.idempotencyKey,
  } : null)
}

export const submitLead = (payload) => call('lead-submit', { method: 'POST', body: payload, auth: false })
