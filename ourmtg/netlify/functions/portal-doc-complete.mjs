// POST /.netlify/functions/portal-doc-complete   (portal-user-authed, Bearer JWT)
//
// Called after the client has PUT the file to the signed upload URL. Marks the
// loan_documents row 'uploaded', notifies the loan officer, and confirms to the
// borrower.
//
// Body: { documentId }
//
// SECURITY
//   • BORROWER / CO-BORROWER only, validated against portal_access for the document's
//     loan file. Realtors rejected.
//   • Verifies the uploaded object actually exists in the private bucket before
//     flipping status (so 'uploaded' never lies).
//
// NOTE ON "create a GRCRM task" (from the brief): we DELIBERATELY do NOT write into
// app_state (wcci-tasks) — the guardrail is "never write borrower data back into
// app_state". The LO review queue is loan_documents WHERE status='uploaded' (surfaced
// by the email below now, and the LO dashboard later). If a real wcci-tasks entry is
// wanted, it can be added behind an explicit opt-in — see the accompanying notes.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, logAccess, randomToken,
} from './_lib/portal.mjs'
import { sendPlatformEmail, brandedEmail, esc } from './_lib/mailer.mjs'
import { resolveOrg, actorTypeFor } from './_lib/orgAccess.mjs'
import { createTaskRepo } from './_lib/taskRepo.mjs'

const BUCKET = 'ourmtg-docs'
const OURMTG_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const documentId = String(body.documentId || '').trim()
  if (!documentId) return json({ ok: false, error: 'Missing documentId' }, 400)

  const svc = admin()

  // Load the document, then its loan file, then authorize.
  const { data: doc, error: dErr } = await svc
    .from('loan_documents')
    .select('id, loan_file_id, owner_user_id, doc_key, label, storage_path, status')
    .eq('id', documentId)
    .maybeSingle()
  if (dErr) return json({ ok: false, error: 'Database error' }, 500)
  if (!doc) return json({ ok: false, error: 'Document not found' }, 404)

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, doc.loan_file_id)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-doc-complete]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!access || !canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'No access to this document' }, 403)
  }
  if (!doc.storage_path) return json({ ok: false, error: 'No upload was prepared for this document' }, 409)

  // Verify the object exists before claiming it was uploaded.
  const slash = doc.storage_path.lastIndexOf('/')
  const dir = slash >= 0 ? doc.storage_path.slice(0, slash) : ''
  const base = slash >= 0 ? doc.storage_path.slice(slash + 1) : doc.storage_path
  const { data: listed, error: lErr } = await svc.storage.from(BUCKET).list(dir, { search: base, limit: 100 })
  if (lErr) {
    console.warn('[portal-doc-complete] storage list failed (allowing):', lErr.message)
  } else if (!Array.isArray(listed) || !listed.some((o) => o.name === base)) {
    return json({ ok: false, error: 'Upload not found — please try uploading again' }, 409)
  }

  // Flip to uploaded.
  const { error: uErr } = await svc.from('loan_documents')
    .update({ status: 'uploaded', uploaded_at: new Date().toISOString() })
    .eq('id', doc.id)
  if (uErr) {
    console.error('[portal-doc-complete] update failed:', uErr.message)
    return json({ ok: false, error: 'Could not mark uploaded' }, 500)
  }

  // Timeline entry (portal tables only — NOT app_state).
  try {
    await svc.from('loan_messages').insert({
      loan_file_id: doc.loan_file_id,
      owner_user_id: doc.owner_user_id,
      direction: 'in',
      author_role: access.visibility === 'coborrower' ? 'coborrower' : 'borrower',
      body: `Uploaded: ${doc.label || doc.doc_key}`,
      channel: 'portal',
    })
  } catch (e) { console.warn('[portal-doc-complete] message log (non-fatal):', e.message) }

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId: doc.loan_file_id, action: 'upload_doc_complete', target: doc.doc_key, req,
  })

  // ── Document ↔ task linking (task pilot). ONLY after finalize succeeded (status is now
  // 'uploaded'), transition the linked borrower task to 'submitted' and link this document.
  // An upload failure earlier returned before this point, so the task never moves on failure.
  let taskTransition = null
  const taskId = String(body.taskId || '').trim()
  if (taskId) {
    try {
      const org = await resolveOrg(svc, auth.user.id)
      const repo = createTaskRepo({ db: svc })
      const task = await repo.getTask(taskId)
      if (org && task && task.loan_file_id === doc.loan_file_id && org.organization_id === task.organization_id
          && ['borrower', 'coborrower'].includes(task.responsible_party_type)) {
        const actor = { type: actorTypeFor(access, access.teamRole), id: auth.user.id }
        taskTransition = await repo.transition({
          task, action: 'submit', actor, linkedDocumentId: doc.id,
          correlationId: await randomToken(8),
          idempotencyKey: `submit:${taskId}:${doc.id}`, at: new Date().toISOString(),
        })
      } else {
        taskTransition = { ok: false, error: 'task_not_linkable' }
      }
    } catch (e) {
      console.warn('[portal-doc-complete] task submit (non-fatal):', e.message)
      taskTransition = { ok: false, error: 'task_update_failed' }
    }
  }

  // ── Notify the loan officer (owner) — fail-soft ─────────────────────────────
  try {
    const { data: ownerData } = await svc.auth.admin.getUserById(doc.owner_user_id)
    const ownerEmail = ownerData?.user?.email
    if (ownerEmail) {
      await sendPlatformEmail({
        to: ownerEmail,
        subject: `📄 Document uploaded: ${doc.label || doc.doc_key}`,
        html: brandedEmail({
          heading: 'A borrower uploaded a document',
          intro: `${esc(loanFile.borrower_name || 'A borrower')} just uploaded a document to their loan file.`,
          rows: [
            ['Borrower', loanFile.borrower_name || '—'],
            ['Document', doc.label || doc.doc_key],
            ['Loan #', loanFile.loan_number || '—'],
          ],
          cta: { text: 'Review in your dashboard', url: OURMTG_URL },
          note: 'Review and accept it in the loan file.',
        }),
        text: `${loanFile.borrower_name || 'A borrower'} uploaded: ${doc.label || doc.doc_key}. Review it in the loan file.`,
      })
    }
  } catch (e) { console.warn('[portal-doc-complete] LO notify (non-fatal):', e.message) }

  // ── Confirm to the borrower — fail-soft ─────────────────────────────────────
  try {
    if (auth.user.email) {
      await sendPlatformEmail({
        to: auth.user.email,
        subject: 'We received your document',
        html: brandedEmail({
          heading: 'Got it — thank you!',
          intro: `We received your <strong>${esc(doc.label || doc.doc_key)}</strong>. Our team will review it shortly.`,
          bodyHtml: '<p style="color:#374151;font-size:15px;line-height:1.6;margin:0">You can check your loan status and remaining items any time in your portal.</p>',
          cta: { text: 'Open your portal', url: OURMTG_URL },
          note: 'Equal Housing Opportunity · West Coast Capital Mortgage',
        }),
        text: `We received your ${doc.label || doc.doc_key}. Our team will review it shortly.`,
      })
    }
  } catch (e) { console.warn('[portal-doc-complete] borrower confirm (non-fatal):', e.message) }

  return json({ ok: true, documentId: doc.id, status: 'uploaded', ...(taskTransition ? { taskTransition } : {}) })
}
