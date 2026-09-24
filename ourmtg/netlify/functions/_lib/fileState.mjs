// Load everything about a loan file once, and hand it to the one function that decides what is
// outstanding.
//
// The contradiction this exists to prevent is the expensive one: a borrower told "you're all
// set" while a processor's panel shows two missing items. That cannot be fixed by being careful
// on two screens — it is fixed by the two screens rendering the same array. `buildFileTasks` is
// that array; this module is the only place that feeds it.
//
// Everything here is a READ. Nothing in this file creates an application, writes an event, or
// changes a document's status, because it is called from a background worker and from page
// loads, and a report that mutates the thing it reports on is a report nobody can trust.

import { listExtractions, listFindings, listAuthorizations, listDocuments } from './preUnderwritingRepo.mjs'
import { findApplication, loadState, listParties, currentMonth } from './applicationRepo.mjs'
import { preUnderwritingChecklist } from './checklist.mjs'
import { readStateForFile } from './readQueue.mjs'
import { groupParts } from '../../../src/features/pre-underwriting/extractionContract.js'
import { computeCompleteness } from '../../../src/features/conversational-1003/completenessEngine.js'
import { buildFileTasks, borrowerView, teamView, nextBorrowerAction } from '../../../src/features/pre-underwriting/fileTasks.js'
import { creditPullAllowed } from '../../../src/features/pre-underwriting/creditAuthorization.js'

/**
 * @returns {Promise<{
 *   tasks: Array, sections: Array, operational: object,
 *   borrower: Array, team: Array, next: object|null,
 *   reading: {pending: Array, failed: Array},
 *   documents: Array, checklist: Array, byType: object, report: object|null,
 * }>}
 */
export async function loadFileState(svc, loanFile, { locale = 'en' } = {}) {
  const [extractions, findings, authorizations, documents, reading] = await Promise.all([
    listExtractions(svc, loanFile.id),
    listFindings(svc, loanFile.id),
    listAuthorizations(svc, loanFile.id),
    listDocuments(svc, loanFile.id),
    readStateForFile(svc, loanFile.id),
  ])

  // The 1003 half. A file with no application yet is a real state and reports as one — the
  // borrower simply has not started, which is different from having answered nothing wrong.
  let report = null
  const application = await findApplication(svc, loanFile.id)
  if (application) {
    const parties = await listParties(svc, application.id)
    const state = await loadState(svc, { application, partyCount: Math.max(1, parties.length) })
    report = computeCompleteness(state, {
      asOfMonth: currentMonth(),
      attested: application.status === 'borrower_attested' || application.status === 'accepted_into_loan_file',
      teamAccepted: application.status === 'accepted_into_loan_file',
    })
  }

  // The exact checklist the borrower's portal renders, from the file's own loan type and
  // purpose — not a parallel one that can disagree with it.
  const checklist = preUnderwritingChecklist({
    loanType: loanFile.loan_type,
    purpose: loanFile.purpose,
  })
  const byType = groupParts(extractions)

  // A document that arrived but has not been read yet. This is not the same as the queue being
  // busy: a job can have failed, or predate the queue entirely, and the file still must not be
  // called complete on the strength of a file nobody has opened.
  const unread = documents
    .filter((d) => d.storage_path && !extractions.some((e) => e.documentId === d.id))
    .map((d) => ({ id: d.id, docKey: d.doc_key, label: d.label }))

  const credit = creditAuthorizationState(authorizations)

  const built = buildFileTasks({
    report, checklist, byType, findings, credit, unread, locale,
    borrowerName: loanFile.borrower_name || '',
  })

  return {
    ...built,
    borrower: borrowerView(built.tasks),
    team: teamView(built.tasks),
    next: nextBorrowerAction(built.tasks),
    reading,
    documents,
    checklist,
    byType,
    report,
    application,
    extractions,
    findings,
  }
}

/**
 * Whether credit may be pulled, in the two-field shape fileTasks expects.
 *
 * `creditPullAllowed` is the authority; this only renames its answer. An expired authorization
 * is deliberately distinguished from one that was never given — the borrower is asked for a
 * different thing in each case, and conflating them produces a confusing request.
 */
function creditAuthorizationState(authorizations) {
  const allowed = creditPullAllowed(authorizations)
  return { authorized: Boolean(allowed.ok), reason: allowed.reason || null }
}
