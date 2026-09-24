// GET /.netlify/functions/portal-arive-handoff?loanFileId=…   (internal-only)
//
// The manual-entry package: everything a WCCM employee needs on screen while they key this file
// into ARIVE, plus the organized document list that backs it.
//
// THIS IS NOT AN INTEGRATION. Nothing here talks to ARIVE, nothing is submitted, and the
// response carries `transfer: { occurred: false }` plus the disclaimer text so that no screen,
// present or future, can render this and imply otherwise. ARIVE stays the system of record; this
// removes the hunting, not the typing.
//
// Internal-only, and that is a product decision rather than an oversight: the sheet is the whole
// application laid out flat with provenance on every value, which is a processor's working view
// and not something a borrower is shown.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, isInternal, logAccess,
} from './_lib/portal.mjs'
import { isUuid } from './_lib/requestGuard.mjs'
import { loadFileState } from './_lib/fileState.mjs'
import { listParties, loadState, currentMonth } from './_lib/applicationRepo.mjs'
import { computeCompleteness } from '../../src/features/conversational-1003/completenessEngine.js'
import { buildCanonicalExport } from '../../src/features/conversational-1003/exportAdapter.js'
import { buildAriveEntrySheet } from '../../src/features/pre-underwriting/ariveEntrySheet.js'
import { organizeDocuments } from '../../src/features/pre-underwriting/documentPackage.js'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await authUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  const url = new URL(req.url)
  const loanFileId = url.searchParams.get('loanFileId')
  if (!isUuid(loanFileId)) return json({ ok: false, error: 'Invalid loanFileId' }, 400)
  const locale = url.searchParams.get('locale') || 'en'

  const svc = admin()
  let loanFile, access
  try {
    loanFile = await loadLoanFile(svc, loanFileId)
    access = await resolveAccess(svc, auth.user.id, loanFile)
  } catch {
    console.error('[portal-arive-handoff] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  if (!isInternal(access)) return json({ ok: false, error: 'Not authorized for this loan file' }, 403)

  let state, sheet
  try {
    state = await loadFileState(svc, loanFile, { locale })
    const documents = organizeDocuments({
      documents: state.documents,
      extractions: state.extractions,
      borrowerName: loanFile.borrower_name || '',
    })

    if (!state.application) {
      // No application means nothing to key. Saying so is the honest answer; producing an empty
      // sheet with a confident header would read as "this file has no data", which is different.
      return json({
        ok: true, loanFileId, ready: false,
        reason: 'The borrower has not started the application yet.',
        transfer: TRANSFER, documents, operational: state.operational,
      })
    }

    const parties = await listParties(svc, state.application.id)
    const appState = await loadState(svc, {
      application: state.application, partyCount: Math.max(1, parties.length),
    })
    const report = computeCompleteness(appState, {
      asOfMonth: currentMonth(),
      attested: state.application.status === 'borrower_attested'
        || state.application.status === 'accepted_into_loan_file',
      teamAccepted: state.application.status === 'accepted_into_loan_file',
    })
    const canonical = buildCanonicalExport(appState, report, {
      applicationId: state.application.id,
      loanFileId,
      parties,
      generatedAt: new Date().toISOString(),
    })
    sheet = buildAriveEntrySheet(canonical, {
      locale,
      borrowerName: loanFile.borrower_name || '',
      loanNumber: loanFile.loan_number || '',
      documents,
    })
  } catch (e) {
    console.error('[portal-arive-handoff] build error:', e?.message)
    return json({ ok: false, error: 'Could not build the entry sheet just now.' }, 500)
  }

  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId, action: 'view_file', target: 'arive_handoff', req,
  })

  return json({
    ok: true,
    loanFileId,
    ready: true,
    sheet,
    // Operational completeness rides along so the person keying can see whether they are typing
    // a finished file or a partial one — and it arrives with its own `meaning`/`notMeaning`.
    operational: state.operational,
    transfer: TRANSFER,
  })
}

// Stated as data rather than as prose in a component, so every consumer of this endpoint carries
// it and none of them can decide to leave it off.
const TRANSFER = Object.freeze({
  occurred: false,
  system: 'ARIVE',
  method: 'manual entry by a WCCM employee',
  note: 'OurMTG does not submit to ARIVE. This file is not in ARIVE until someone enters it.',
})
