// POST /.netlify/functions/portal-loanfile-set   (authed, Bearer JWT)
//
// Create or update a loan file MANUALLY — the standalone-mode path for deployments
// where OurMTG runs on its own Supabase project (no GRCRM app_state to project from).
// The projector (sync-loan-file) remains the automatic path when GRCRM shares the
// database; manual files use source_deal_id 'manual_<hex>' so the two never collide.
//
// Body (create): { borrowerName, loanType?, purpose?, stage?, amount?, estCloseDate?, loanNumber? }
// Body (update): { loanFileId, ...any of the fields above }
//
// SECURITY
//   • Create: the caller becomes the file's owner (owner_user_id = caller). A newly
//     created file contains only what the caller typed and grants access to nobody
//     else until they mint invites — same trust model as signing up for any CRM.
//   • Update: internal only (owner or portal_team member). Never touches
//     preapproval_* (portal-preapproval-set is the only writer, deliberately).
//   • Stage changes append a timeline entry so the borrower sees progress.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
  randomToken, STAGE_STEPS, stageInfo,
} from './_lib/portal.mjs'

const LOAN_TYPES = new Set(['Conventional', 'FHA', 'VA', 'Jumbo', 'USDA', 'Non-QM', 'DSCR'])
const PURPOSES = new Set(['Purchase', 'Rate-Term Refi', 'Cash-out Refi', 'HELOC'])

const str = (v, max = 200) => {
  if (v == null) return null
  const s = String(v).trim().slice(0, max)
  return s || null
}
const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined // undefined = invalid
}
const isoDate = (v) => {
  if (v == null || v === '') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim())
  return m ? m[0] : undefined
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const loanFileId = body.loanFileId ? String(body.loanFileId).trim() : null

  // Validate shared fields (undefined = present but invalid → 400).
  const fields = {}
  if (body.borrowerName !== undefined) fields.borrower_name = str(body.borrowerName, 120)
  if (body.loanNumber !== undefined) fields.loan_number = str(body.loanNumber, 60)
  if (body.loanType !== undefined) {
    const t = str(body.loanType, 40)
    if (t && !LOAN_TYPES.has(t)) return json({ ok: false, error: 'Invalid loanType' }, 400)
    fields.loan_type = t
  }
  if (body.purpose !== undefined) {
    const p = str(body.purpose, 40)
    if (p && !PURPOSES.has(p)) return json({ ok: false, error: 'Invalid purpose' }, 400)
    fields.purpose = p
  }
  if (body.stage !== undefined) {
    const s = str(body.stage, 30)
    if (!s || !STAGE_STEPS.includes(s)) return json({ ok: false, error: 'Invalid stage' }, 400)
    fields.stage = s
  }
  if (body.amount !== undefined) {
    const a = num(body.amount)
    if (a === undefined) return json({ ok: false, error: 'amount must be a non-negative number' }, 400)
    fields.amount = a
  }
  if (body.estCloseDate !== undefined) {
    const d = isoDate(body.estCloseDate)
    if (d === undefined) return json({ ok: false, error: 'estCloseDate must be YYYY-MM-DD' }, 400)
    fields.est_close_date = d
  }

  const svc = admin()

  // ── Update ─────────────────────────────────────────────────────────────────
  if (loanFileId) {
    let loanFile, access
    try {
      loanFile = await loadLoanFile(svc, loanFileId)
      access = await resolveAccess(svc, auth.user.id, loanFile)
    } catch (e) {
      console.error('[portal-loanfile-set]', e.message)
      return json({ ok: false, error: 'Database error' }, 500)
    }
    if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
    if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
    if (Object.keys(fields).length === 0) return json({ ok: false, error: 'Nothing to update' }, 400)

    const { data: upd, error: uErr } = await svc
      .from('loan_files')
      .update(fields)
      .eq('id', loanFileId)
      .select('*')
      .maybeSingle()
    if (uErr) {
      console.error('[portal-loanfile-set] update failed:', uErr.message)
      return json({ ok: false, error: 'Could not update the loan file' }, 500)
    }

    // Stage change → borrower-visible timeline entry.
    if (fields.stage && fields.stage !== loanFile.stage) {
      try {
        await svc.from('loan_messages').insert({
          loan_file_id: loanFileId,
          owner_user_id: loanFile.owner_user_id,
          direction: 'out',
          author_role: 'system',
          body: `Loan status updated: ${stageInfo(fields.stage).label}`,
          channel: 'portal',
        })
      } catch (e) { console.warn('[portal-loanfile-set] message log (non-fatal):', e.message) }
    }

    await logAccess(svc, { portalUser: auth.user.id, loanFileId, action: 'loanfile_updated', target: Object.keys(fields).join(','), req })
    return json({ ok: true, loanFileId, file: upd })
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  if (!fields.borrower_name) return json({ ok: false, error: 'borrowerName is required' }, 400)

  const { data: ins, error: iErr } = await svc.from('loan_files').insert({
    owner_user_id: auth.user.id,
    source_deal_id: `manual_${await randomToken(8)}`,
    borrower_name: fields.borrower_name,
    loan_number: fields.loan_number ?? null,
    loan_type: fields.loan_type ?? 'Conventional',
    purpose: fields.purpose ?? 'Purchase',
    stage: fields.stage ?? 'lead',
    amount: fields.amount ?? null,
    est_close_date: fields.est_close_date ?? null,
  }).select('*').maybeSingle()
  if (iErr) {
    console.error('[portal-loanfile-set] insert failed:', iErr.message)
    return json({ ok: false, error: 'Could not create the loan file' }, 500)
  }

  await logAccess(svc, { portalUser: auth.user.id, loanFileId: ins.id, action: 'loanfile_created', target: ins.borrower_name, req })
  return json({ ok: true, loanFileId: ins.id, file: ins })
}
