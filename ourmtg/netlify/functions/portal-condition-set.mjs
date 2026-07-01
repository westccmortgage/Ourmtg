// POST /.netlify/functions/portal-condition-set   (internal: LO/owner or team, Bearer JWT)
//
// Create or update an underwriting condition on a loan file — the write path the
// condition center was missing (loan_conditions previously had no writer at all).
// The borrower sees conditions read-only via RLS; satisfying one happens by upload
// or message, and the LO/processor clears it here.
//
// Body (create): { loanFileId, title, detail? }
// Body (update): { loanFileId, conditionId, status? ('open'|'submitted'|'cleared'), title?, detail? }
//
// SECURITY: internal only. Writes loan_conditions + a timeline entry. Never app_state.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'

const STATUSES = new Set(['open', 'submitted', 'cleared'])

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = String(body.loanFileId || '').trim()
  const conditionId = body.conditionId ? String(body.conditionId).trim() : null
  const title = body.title != null ? String(body.title).trim().slice(0, 200) : null
  const detail = body.detail != null ? String(body.detail).trim().slice(0, 2000) : null
  const status = body.status != null ? String(body.status).trim() : null

  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)
  if (status && !STATUSES.has(status)) return json({ ok: false, error: 'Invalid status' }, 400)
  if (!conditionId && (!title || title.length < 3)) {
    return json({ ok: false, error: 'A condition title is required' }, 400)
  }

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-condition-set]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  const authorRole = access.role === 'team' ? 'processor' : 'lo'
  let condition

  if (conditionId) {
    // ── Update ── scoped to this loan file so an id can't cross files.
    const patch = {}
    if (title) patch.title = title
    if (detail != null) patch.detail = detail
    if (status) patch.status = status
    if (Object.keys(patch).length === 0) return json({ ok: false, error: 'Nothing to update' }, 400)

    const { data: upd, error: uErr } = await svc
      .from('loan_conditions')
      .update(patch)
      .eq('id', conditionId).eq('loan_file_id', loanFileId)
      .select('id, title, detail, status, created_at, updated_at')
      .maybeSingle()
    if (uErr) return json({ ok: false, error: 'Database error' }, 500)
    if (!upd) return json({ ok: false, error: 'Condition not found' }, 404)
    condition = upd

    if (status === 'cleared') {
      try {
        await svc.from('loan_messages').insert({
          loan_file_id: loanFileId, owner_user_id: loanFile.owner_user_id,
          direction: 'out', author_role: authorRole,
          body: `Condition cleared: ${condition.title}`, channel: 'portal',
        })
      } catch (e) { console.warn('[portal-condition-set] message log (non-fatal):', e.message) }
    }
  } else {
    // ── Create ──
    const { data: ins, error: iErr } = await svc.from('loan_conditions').insert({
      loan_file_id: loanFileId,
      owner_user_id: loanFile.owner_user_id,
      title,
      detail,
      status: status || 'open',
    }).select('id, title, detail, status, created_at, updated_at').maybeSingle()
    if (iErr) {
      console.error('[portal-condition-set] insert failed:', iErr.message)
      return json({ ok: false, error: 'Could not create condition' }, 500)
    }
    condition = ins

    try {
      await svc.from('loan_messages').insert({
        loan_file_id: loanFileId, owner_user_id: loanFile.owner_user_id,
        direction: 'out', author_role: authorRole,
        body: `New condition: ${title}`, channel: 'portal',
      })
    } catch (e) { console.warn('[portal-condition-set] message log (non-fatal):', e.message) }
  }

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId,
    action: conditionId ? 'condition_updated' : 'condition_created',
    target: condition.id, req,
  })

  return json({ ok: true, condition })
}
