// Phase 1C Functional Completion — pure UI action model.
// Keeps rendered actions aligned with the canonical Phase 1B lifecycle.

const TEAM_ACTIONS = Object.freeze({
  submitted: [
    { action: 'sendToTeamReview', label: 'To review' },
    { action: 'requestMoreInfo', label: 'More info', needsBorrowerReason: true },
  ],
  team_review: [
    { action: 'accept', label: 'Accept', primary: true },
    { action: 'reject', label: 'Reject', needsBorrowerReason: true },
    { action: 'requestMoreInfo', label: 'More info', needsBorrowerReason: true },
  ],
  accepted: [
    { action: 'complete', label: 'Complete', primary: true },
    { action: 'reopen', label: 'Reopen', needsBorrowerReason: true },
  ],
  completed: [
    { action: 'reopen', label: 'Reopen', needsBorrowerReason: true },
  ],
  rejected: [
    { action: 'reopen', label: 'Reopen', needsBorrowerReason: true },
  ],
})

export function teamActionsForTask(status) {
  return TEAM_ACTIONS[status] ? TEAM_ACTIONS[status].map((a) => ({ ...a })) : []
}

export function actionNeedsBorrowerReason(action) {
  return action === 'reject' || action === 'requestMoreInfo' || action === 'reopen'
}

// The borrower reaches in_progress before a linked document may be finalized.
export function borrowerPreparationActions(status) {
  if (status === 'assigned') return ['view', 'begin']
  if (['viewed', 'rejected', 'more_information_needed', 'reopened'].includes(status)) return ['begin']
  if (status === 'in_progress') return []
  return null
}
