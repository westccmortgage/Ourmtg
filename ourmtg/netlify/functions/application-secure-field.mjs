// POST /.netlify/functions/application-secure-field   (borrower-authed, Bearer JWT)
//
// The ONLY path by which an SSN or account number can enter the application (§15). It is
// deliberately not part of the conversation: the value never reaches a language model, never
// enters the transcript, and is never returned in full after storage.
//
// WHAT IS STORED: a masked fragment (last four) plus a keyed digest for duplicate detection.
// The plaintext is NOT persisted by this endpoint — wiring an encrypted column requires a KMS
// decision the owner has not made yet, and storing an unencrypted SSN in the meantime would be
// worse than not storing it. See CONVERSATIONAL-1003-DEPLOYMENT-REQUIREMENTS.md.

import { createHmac } from 'node:crypto'
import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, logAccess,
} from './_lib/portal.mjs'
import { readJsonBody, isUuid, isEnum } from './_lib/requestGuard.mjs'
import { isValidIdempotencyKey } from './_lib/idempotency.mjs'
import { conversational1003Enabled } from './_lib/conversational1003.mjs'
import {
  ensureApplication, ensureParty, listParties, loadState, persistEvents, syncProjection,
  updateApplication, currentMonth, newId,
} from './_lib/applicationRepo.mjs'
import { recordValue } from '../../src/features/conversational-1003/applicationReducer.js'
import { computeCompleteness } from '../../src/features/conversational-1003/completenessEngine.js'
import { planNextQuestion } from '../../src/features/conversational-1003/questionPlanner.js'
import { getField, SECURE_FIELDS, templatePath } from '../../src/features/conversational-1003/applicationCatalog.js'

// Format checks only — we do not validate against any government or bank system, and must not
// imply that we do.
const VALIDATORS = {
  ssn: (digits) => digits.length === 9
    && !/^(000|666|9\d\d)/.test(digits)
    && digits.slice(3, 5) !== '00'
    && digits.slice(5) !== '0000',
  account_number: (digits) => digits.length >= 4 && digits.length <= 17,
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)
  if (!conversational1003Enabled()) return json({ ok: false, error: 'Not available' }, 404)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const parsed = await readJsonBody(req, { maxBytes: 8_000 })
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status)
  const body = parsed.body

  if (!isUuid(body.loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  if (!isValidIdempotencyKey(body.idempotencyKey)) {
    return json({ ok: false, error: 'A valid idempotencyKey is required' }, 400)
  }
  const fieldPath = typeof body.fieldPath === 'string' ? body.fieldPath : ''
  // Only fields the catalog marks secureEntry may be written here — nothing else.
  if (!SECURE_FIELDS.includes(templatePath(fieldPath))) {
    return json({ ok: false, error: 'That field is not a secure field' }, 400)
  }
  const field = getField(fieldPath)
  const digits = String(body.value ?? '').replace(/\D/g, '')
  const validator = VALIDATORS[field.type]
  if (!validator || !validator(digits)) {
    return json({ ok: false, error: 'That does not look complete. Please check and re-enter it.' }, 400)
  }

  const locale = isEnum(body.locale, ['en', 'es', 'ru']) ? body.locale : 'en'
  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, body.loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!access || !['borrower', 'coborrower'].includes(access.visibility)) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  try {
    const application = await ensureApplication(svc, { loanFile, createdBy: auth.user.id, locale })
    const party = await ensureParty(svc, {
      application, loanFile, userId: auth.user.id, visibility: access.visibility, locale,
    })
    const parties = await listParties(svc, application.id)
    const lastFour = digits.slice(-4)

    // Keyed digest, not a bare hash: a plain SHA-256 of a 9-digit SSN is trivially brute-forced.
    const secret = process.env.OURMTG_SECURE_FIELD_KEY || process.env.OURMTG_FINGERPRINT_SALT
    if (!secret) {
      console.error('[application-secure-field] no key configured')
      return json({ ok: false, error: 'Secure entry is not available right now.' }, 503)
    }
    const valueDigest = createHmac('sha256', secret).update(`${field.type}:${digits}`).digest('hex')

    const { error: upErr } = await svc.from('application_secure_fields').upsert({
      application_id: application.id,
      party_id: party.id,
      organization_id: loanFile.organization_id || null,
      loan_file_id: loanFile.id,
      field_path: fieldPath,
      last_four: lastFour,
      value_digest: valueDigest,
      captured_by: auth.user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'application_id,field_path,party_id' })
    if (upErr) throw new Error('secure field write: ' + upErr.message)

    // The application state records ONLY the mask, so nothing downstream can leak the value.
    const state = await loadState(svc, { application, partyCount: Math.max(1, parties.length) })
    const at = new Date().toISOString()
    const res = recordValue(state, {
      path: fieldPath,
      rawValue: `••••${lastFour}`,
      source: 'borrower_secure_input',
      at,
      eventId: newId(),
      actor: auth.user.id,
      status: 'borrower_confirmed',
    })
    if (res.event) {
      await persistEvents(svc, {
        application, party, loanFile, events: [res.event], turnId: null,
      })
      await syncProjection(svc, {
        application, party, loanFile, state: res.state, paths: [fieldPath],
      })
    }

    const asOfMonth = currentMonth()
    const report = computeCompleteness(res.state, { asOfMonth })
    await updateApplication(svc, application.id, {
      status: report.status, percent_complete: report.percent,
    })
    await logAccess(svc, {
      // Deliberately no value, no last-four in the audit target.
      portalUser: auth.user.id, loanFileId: loanFile.id, action: 'application_secure_field',
      target: templatePath(fieldPath), req,
    })

    return json({
      ok: true,
      fieldPath,
      masked: `•••-••-${lastFour}`.slice(-11),
      nextQuestion: planNextQuestion(res.state, {
        asOfMonth, locale, askedHistory: party.asked_history || {},
      }),
      progress: { percent: report.percent, status: report.status },
    })
  } catch (e) {
    console.error('[application-secure-field]', e?.message || e)
    return json({ ok: false, error: 'Could not save that securely. Please try again.' }, 500)
  }
}
