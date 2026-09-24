// GET /.netlify/functions/portal-file-state?loanFileId=…
//
// One endpoint, two audiences, ONE underlying array.
//
// The bug this shape exists to prevent is the expensive one: a borrower told "you're all set"
// while a processor's panel shows two outstanding items. That is not fixable by being careful on
// two screens — it is fixed by the two screens being projections of the same list. So both views
// are served from here, from one `buildFileTasks` call, and the difference between them is which
// projection runs, not which computation.
//
// WHAT A BORROWER GETS: their own tasks, with the request sentences completeness.js wrote, and
// the sections rolled up. No findings — structurally, not by filtering: a finding is never
// borrower-owned and `borrowerView` selects on ownership.
//
// WHAT THE TEAM GETS: all of that, plus the human-review items, plus which side each outstanding
// item belongs to.
//
// WHAT NOBODY GETS: an approval, a denial, a probability, a score. The operational number this
// returns is arithmetic over a checklist and travels with the sentences that say so.

import { admin, isConfigured } from './_lib/supabase.mjs'
import {
  authUser, json, preflight, loadLoanFile, resolveAccess, canSeeFinancials, isInternal, logAccess,
} from './_lib/portal.mjs'
import { isUuid } from './_lib/requestGuard.mjs'
import { loadFileState } from './_lib/fileState.mjs'
import { organizeDocuments } from '../../src/features/pre-underwriting/documentPackage.js'
import { SECTION_TITLES } from '../../src/features/pre-underwriting/fileTasks.js'

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
    console.error('[portal-file-state] authorization error')
    return json({ ok: false, error: 'Database error' }, 500)
  }
  if (!loanFile) return json({ ok: false, error: 'Loan file not found' }, 404)
  // Realtors, escrow and title are structurally excluded. What is outstanding on a file names
  // the borrower's debts and documents; it is not deal-progress information.
  if (!access || !canSeeFinancials(access.visibility)) {
    return json({ ok: false, error: 'Not authorized for this loan file' }, 403)
  }

  let state
  try {
    state = await loadFileState(svc, loanFile, { locale })
  } catch (e) {
    console.error('[portal-file-state] state error:', e?.message)
    return json({ ok: false, error: 'Could not load this file just now.' }, 500)
  }

  const internal = isInternal(access)
  await logAccess(svc, {
    portalUser: auth.user.id, loanFileId,
    action: 'view_file', target: internal ? 'file_state:team' : 'file_state:borrower', req,
  })

  const shared = {
    ok: true,
    loanFileId,
    view: internal ? 'team' : 'borrower',
    operational: state.operational,
    sections: state.sections.map((s) => ({ ...s, title: SECTION_TITLES[s.key] || s.title })),
    // Documents still being read. Said plainly so the screen can show "we're reviewing this"
    // instead of a silence the borrower reads as "nothing happened".
    reading: state.reading.pending.length,
  }

  if (!internal) {
    return json({
      ...shared,
      tasks: state.borrower,
      next: state.next,
      // A borrower's own sections, with the review counts stripped: "two items in review" is
      // information about what the loan team is doing, not about what they must do.
      sections: shared.sections.map(({ key, title, borrowerOpen, state: st }) => ({
        key, title, open: borrowerOpen,
        state: borrowerOpen > 0 ? 'needs_attention' : (st === 'not_applicable' ? 'not_applicable' : 'complete'),
      })),
    })
  }

  return json({
    ...shared,
    tasks: state.team,
    borrowerTasks: state.borrower,
    next: state.next,
    // Which documents failed to read and why — the one queue fact a processor acts on.
    readFailures: state.reading.failed,
    documents: organizeDocuments({
      documents: state.documents,
      extractions: state.extractions,
      borrowerName: loanFile.borrower_name || '',
    }),
  })
}
