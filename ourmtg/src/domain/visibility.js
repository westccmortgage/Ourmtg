// Phase 1B — centralized borrower/role VISIBILITY rules for the new operational data
// (tasks, cash-to-close, internal notes, third-party items). Pure predicates. Server-side
// authorization remains authoritative (_lib/portal.mjs); this mirrors those rules for the
// new domain and is the single place the UI + services consult. Frontend gating is NOT
// security — every server endpoint must re-check.

const BORROWER = new Set(['borrower', 'coborrower'])
const TEAM = new Set(['loan_officer', 'processor', 'assistant'])
const PARTNER = new Set(['realtor', 'escrow', 'title'])

export const isBorrowerRole = (r) => BORROWER.has(r)
export const isTeamRole = (r) => TEAM.has(r)
export const isPartnerRole = (r) => PARTNER.has(r)

// A borrower/coborrower or team member may view a file's borrower tasks ONLY with a grant to
// that file (or team membership of its owner). Partners never see financial tasks.
export function canViewBorrowerTasks(role, { hasGrant = false, isTeam = false } = {}) {
  if (isTeamRole(role) || isTeam) return true
  if (isBorrowerRole(role)) return !!hasGrant
  return false // realtor/escrow/title and everyone else: no
}

// Internal notes / internal requirements are team-only — never shown to borrowers or partners.
export function canViewInternalNotes(role) {
  return isTeamRole(role)
}

// Financial documents (income/assets/statements) — borrower/coborrower (own file) + team only.
export function canViewFinancialDocuments(role, { hasGrant = false, isTeam = false } = {}) {
  if (isTeamRole(role) || isTeam) return true
  if (isBorrowerRole(role)) return !!hasGrant
  return false
}

// Cash-to-close detail — borrower/coborrower (own file) + team. Never realtor/escrow/title.
export function canViewCashToClose(role, { hasGrant = false, isTeam = false } = {}) {
  return canViewFinancialDocuments(role, { hasGrant, isTeam })
}

// What a realtor/partner may see — milestone-level only, never financial detail.
export function realtorVisibleFields() {
  return Object.freeze({
    stage: true,
    majorMilestone: true,
    preapprovalBand: true,
    estimatedCloseDate: true,
    income: false,
    assets: false,
    creditDetail: false,
    documents: false,
    internalNotes: false,
    cashAccounts: false,
    cashToClose: false,
  })
}

// Escrow/title: only explicitly permitted transaction milestones; never borrower financials.
export function escrowTitleVisibleFields() {
  return Object.freeze({
    permittedTransactionMilestones: true,
    borrowerFinancialDocuments: false,
    income: false,
    assets: false,
    internalNotes: false,
  })
}

// Admin (platform) authority is separate from loan ownership — always answered by the
// OURMTG_ADMIN_EMAILS allowlist server-side (see _lib/portal.isSettingsAdmin), never by role here.
export function loanRoleGrantsPlatformAdmin() {
  return false
}
