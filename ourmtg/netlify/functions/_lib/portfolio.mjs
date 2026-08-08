// Deterministic presentation of the stored 1003 workflow state for the internal
// admin portfolio. This module never infers completeness from answers: the
// mortgage_applications row is the source of truth, and an absent row is "not started".

const APPLICATION_META = {
  not_started: { key: 'notStarted', label: 'Not started' },
  in_progress: { key: 'inProgress', label: 'In progress' },
  waiting_on_borrower: { key: 'inProgress', label: 'Waiting on borrower' },
  needs_clarification: { key: 'inProgress', label: 'Needs clarification' },
  returned_for_clarification: { key: 'inProgress', label: 'Returned for clarification' },
  ready_for_borrower_review: { key: 'readyForBorrowerReview', label: 'Ready for borrower review' },
  borrower_attested: { key: 'attested', label: 'Borrower attested' },
  ready_for_team_review: { key: 'attested', label: 'Ready for team review' },
  accepted_into_loan_file: { key: 'accepted', label: 'Accepted into loan file' },
}

export const emptyApplicationCounts = () => ({
  notStarted: 0,
  inProgress: 0,
  readyForBorrowerReview: 0,
  attested: 0,
  accepted: 0,
})

export function applicationProgress(application) {
  const status = application?.status || 'not_started'
  const meta = APPLICATION_META[status] || APPLICATION_META.in_progress
  const rawPercent = application?.percent_complete
  const parsedPercent = rawPercent === null || rawPercent === undefined || rawPercent === ''
    ? null
    : Number(rawPercent)

  return {
    status,
    bucket: meta.key,
    label: meta.label,
    percentComplete: Number.isFinite(parsedPercent)
      ? Math.max(0, Math.min(100, Math.round(parsedPercent)))
      : null,
    updatedAt: application?.updated_at || null,
  }
}

export function summarizeOwners(ownerAccounts, files) {
  return ownerAccounts.map((owner) => {
    const ownerFiles = files.filter((file) => file.ownerUserId === owner.userId)
    const applicationCounts = emptyApplicationCounts()
    const stageCounts = {}

    for (const file of ownerFiles) {
      const bucket = file.application?.bucket || 'notStarted'
      applicationCounts[bucket] = (applicationCounts[bucket] || 0) + 1
      const stage = file.stage || 'lead'
      stageCounts[stage] = (stageCounts[stage] || 0) + 1
    }

    return {
      ...owner,
      fileCount: ownerFiles.length,
      applicationCounts,
      stageCounts,
    }
  })
}
