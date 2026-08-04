// GET  /.netlify/functions/credit-authorization?loanFileId=…   (borrower or team)
// POST /.netlify/functions/credit-authorization                (BORROWER ONLY)
//
// The borrower's permission to pull their credit.
//
// THE ASYMMETRY IS THE POINT. The loan team can see whether permission exists — they have to, in
// order to know whether they may order a report. They cannot give it. Under the FCRA the
// permissible purpose rests on the consumer having authorized the pull, and an authorization
// recorded by the person who benefits from it is not one.
//
// So POST refuses anyone who is not the borrower or co-borrower, including the file's owner,
// and there is no assisted path the way there is for the application interview. A loan officer
// taking a 1003 over the phone is ordinary practice; a loan officer clicking "I authorize" on
// the borrower's behalf is not the same act at all.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, canSeeFinancials,
  logAccess, ipOf, uaOf,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { logEvent } from './_lib/safelog.mjs'
import { preUnderwritingEnabled } from './_lib/documentIntake.mjs'
import { listAuthorizations, newId } from './_lib/preUnderwritingRepo.mjs'
import {
  CREDIT_AUTHORIZATION, CREDIT_AUTH_VERSION, creditPullAllowed, validateAcceptance,
} from '../../src/features/pre-underwriting/creditAuthorization.js'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!preUnderwritingEnabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const isPost = req.method === 'POST'
  let body = {}
  let loanFileId
  if (isPost) {
    const parsed = await readJsonBody(req)
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
    body = parsed.body
    loanFileId = body.loanFileId
  } else if (req.method === 'GET') {
    loanFileId = new URL(req.url).searchParams.get('loanFileId')
  } else {
    return json({ ok: false, error: 'Method not allowed' }, 405)
  }
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  // Realtors, escrow and title never see this. Whether someone authorized a credit pull is not
  // a milestone — it is a fact about their consumer file.
  if (!access || !canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  const borrowerSide = ['borrower', 'coborrower'].includes(access.visibility)
  const partyIndex = access.visibility === 'coborrower' ? 1 : 0

  try {
    if (!isPost) {
      const authorizations = await listAuthorizations(svc, loanFile.id)
      const check = creditPullAllowed(authorizations, { partyIndex: borrowerSide ? partyIndex : 0 })
      return json({
        ok: true,
        // The team sees only whether permission exists and when it lapses — never the borrower's
        // IP or user agent, which are evidence, not operational data.
        authorized: check.ok,
        reason: check.reason,
        expiresAt: check.expiresAt ? new Date(check.expiresAt).toISOString() : null,
        canAuthorize: borrowerSide,
        // Echoed back on acceptance so we can prove which wording was displayed.
        documentVersion: CREDIT_AUTH_VERSION,
        text: CREDIT_AUTHORIZATION,
        ...(isInternal(access) ? {
          history: authorizations.map((a) => ({
            partyIndex: a.partyIndex, acceptedAt: a.acceptedAt, revokedAt: a.revokedAt,
            documentVersion: a.documentVersion,
          })),
        } : {}),
      })
    }

    // ── POST: only the consumer authorizes ─────────────────────────────────
    if (!borrowerSide) {
      logEvent('pu.credit_auth.refused_internal', { severity: 'warn', loanFileId: loanFile.id })
      return json({
        ok: false,
        error: 'Only the borrower can authorize a credit check. Send them the link — it is one tap on their side.',
        code: 'borrower_only',
      }, 403)
    }
    if (!isValidIdempotencyKey(body.idempotencyKey)) {
      return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
    }

    // Revocation. Kept simple and separate: it stamps the existing record rather than deleting
    // it, because the authorization did happen and the file has to keep saying so.
    if (body.revoke === true) {
      const authorizations = await listAuthorizations(svc, loanFile.id)
      const live = authorizations.find((a) => a.partyIndex === partyIndex && !a.revokedAt)
      if (!live) return json({ ok: false, error: 'There is nothing to withdraw.' }, 409)
      await svc.from('credit_authorizations')
        .update({ revoked_at: new Date().toISOString(), revoked_by: auth.user.id })
        .eq('id', live.id)
      await logAccess(svc, {
        portalUser: auth.user.id, loanFileId: loanFile.id,
        action: 'credit_authorization_revoked', target: live.id, req,
      })
      return json({ ok: true, authorized: false, reason: 'revoked' })
    }

    const validated = validateAcceptance({ ...body, partyIndex }, {})
    if (!validated.ok) {
      return json({ ok: false, error: ACCEPT_ERRORS[validated.error] || 'That could not be recorded.', code: validated.error }, 409)
    }

    const { data, error } = await svc.from('credit_authorizations').insert({
      organization_id: loanFile.organization_id || null,
      loan_file_id: loanFile.id,
      party_index: validated.value.partyIndex,
      document_version: validated.value.documentVersion,
      presented_at: validated.value.presentedAt,
      accepted_at: validated.value.acceptedAt,
      accepted_by: auth.user.id,
      ip: ipOf(req),
      user_agent: uaOf(req),
    }).select('id, accepted_at').maybeSingle()
    if (error) throw new Error('authorization write: ' + error.message)

    await logAccess(svc, {
      portalUser: auth.user.id, loanFileId: loanFile.id,
      action: 'credit_authorization_accepted', target: CREDIT_AUTH_VERSION, req,
    })

    const check = creditPullAllowed(await listAuthorizations(svc, loanFile.id), { partyIndex })
    return json({
      ok: true,
      authorized: true,
      acceptedAt: data.accepted_at,
      expiresAt: check.expiresAt ? new Date(check.expiresAt).toISOString() : null,
      // Stated back, so the last thing the borrower reads is what this did and did not do.
      meaning: 'You have given permission for one credit check for this loan.',
      notMeaning: [
        'an approval or a pre-approval',
        'a commitment to lend',
        'permission for anyone else to check your credit',
      ],
    })
  } catch (e) {
    console.error('[credit-authorization]', e?.message || e)
    return json({ ok: false, error: 'Could not record that. Please try again.', requestId: newId() }, 500)
  }
}

const ACCEPT_ERRORS = {
  stale_version: 'Please reload and read the current wording before authorizing.',
  not_accepted: 'The authorization was not accepted.',
  invalid_presented_at: 'Please reload and try again.',
  invalid_party: 'We could not tell who is authorizing.',
}
