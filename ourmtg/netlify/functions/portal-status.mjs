// GET /.netlify/functions/portal-status?loanFileId=<id>   (portal-user-authed, Bearer JWT)
//
// Read-only loan status tracker. Reads loan_files ONLY (never app_state). The response
// is scoped to the caller's visibility:
//
//   • borrower / co-borrower / owner → safe borrower view: stage + 7-step tracker,
//     "what's next", loan type/purpose, their own loan amount, estimated close date.
//   • realtor → MILESTONE ONLY: coarse milestone label + estimated close date +
//     LO-published pre-approval band. NO loan amount, NO rate, NO documents, NO
//     conditions — nothing financial/private.
//
// No document or condition data is ever returned here; those have their own
// borrower-only endpoints.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, logAccess,
  stageInfo, STAGE_STEPS,
} from './_lib/portal.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const url = new URL(req.url)
  const loanFileId = String(url.searchParams.get('loanFileId') || '').trim()
  if (!loanFileId) return json({ ok: false, error: 'Missing loanFileId' }, 400)

  const svc = admin()

  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch (e) {
    console.error('[portal-status]', e.message)
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access) return json({ ok: false, error: 'No access to this loan file' }, 403)

  const info = stageInfo(loanFile.stage)
  const steps = STAGE_STEPS.map((key) => {
    const m = stageInfo(key)
    return { key, label: m.label, done: m.step < info.step, current: key === loanFile.stage }
  })

  await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'status', req })

  // ── Realtor: milestone-only, zero financials ────────────────────────────────
  if (!canSeeFinancials(access.visibility)) {
    return json({
      ok: true,
      view: 'realtor',
      loanFileId,
      borrowerName: loanFile.borrower_name || null,
      milestone: info.realtor,
      step: info.step,
      totalSteps: STAGE_STEPS.length,
      estCloseDate: loanFile.est_close_date || null,
      preApproval: loanFile.preapproval_amount
        ? { amount: Number(loanFile.preapproval_amount), expires: loanFile.preapproval_expires || null }
        : null,
      // Deliberately omitted for realtors: loan amount, rate, documents, conditions.
    })
  }

  // ── Borrower / co-borrower / owner: safe borrower view ──────────────────────
  return json({
    ok: true,
    view: access.role === 'owner' ? 'owner' : 'borrower',
    loanFileId,
    borrowerName: loanFile.borrower_name || null,
    stage: loanFile.stage,
    stageLabel: info.label,
    step: info.step,
    totalSteps: STAGE_STEPS.length,
    steps,
    whatsNext: info.borrower,
    loanType: loanFile.loan_type || null,
    purpose: loanFile.purpose || null,
    amount: loanFile.amount != null ? Number(loanFile.amount) : null,
    estCloseDate: loanFile.est_close_date || null,
  })
}
