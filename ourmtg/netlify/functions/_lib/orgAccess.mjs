// Phase 1C — organization access resolution for the task pilot. The organization boundary is
// explicit: a caller acts within an organization they are an active member of, AND must still
// pass the existing per-loan-file authorization (resolveAccess). Membership is NEVER inferred
// from an email domain. Single-org pilot: a caller's org is their first active membership.

// Resolve the caller's active organization membership. Returns { organization_id, role } or null.
// Tolerates a missing table (42P01) so the app degrades cleanly before the pilot migration runs.
export async function resolveOrg(svc, userId) {
  const { data, error } = await svc
    .from('organization_members')
    .select('organization_id, role, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()
  if (error && error.code !== '42P01') throw new Error('organization_members read: ' + error.message)
  if (!data) return null
  return { organization_id: data.organization_id, role: data.role }
}

// Map an access visibility (from resolveAccess) to a task-service actor type.
export function actorTypeFor(access, teamRole) {
  if (!access) return null
  if (access.role === 'owner') return 'loan_officer'
  if (access.role === 'team') return teamRole === 'assistant' ? 'assistant' : 'processor'
  // portal grant → borrower/coborrower/realtor/escrow/title
  return access.visibility
}
