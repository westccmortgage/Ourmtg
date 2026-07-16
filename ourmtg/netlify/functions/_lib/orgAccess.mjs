// Phase 1C — organization access resolution for the task pilot. The organization boundary is
// explicit: a caller acts within an organization they are an ACTIVE member of, AND must still
// pass the existing per-loan-file authorization (resolveAccess). Membership is NEVER inferred
// from an email domain.
//
// Review fixes:
//   F3: multi-org safety — verify membership in a SPECIFIC organization (the record's org),
//       not just the caller's arbitrary first membership.
//   F10: distinguish "pilot not provisioned" (table absent) from "not a member" (forbidden).

// Resolve the caller's active organization membership for CREATE/LIST (no record org yet).
// Returns { ok, provisioned, org }:
//   provisioned=false → the pilot schema isn't applied (organization_members missing) → 503.
//   ok=false, provisioned=true → the caller is not an active member of any org → 403.
//   ok=true → org = { organization_id, role }.
export async function resolveOrg(svc, userId) {
  const { data, error } = await svc
    .from('organization_members')
    .select('organization_id, role, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    if (error.code === '42P01') return { ok: false, provisioned: false, org: null }
    throw new Error('organization_members read: ' + error.message)
  }
  if (!data) return { ok: false, provisioned: true, org: null }
  return { ok: true, provisioned: true, org: { organization_id: data.organization_id, role: data.role } }
}

// F3: verify the caller is an ACTIVE member of a SPECIFIC organization (the record's org).
// Returns { ok, provisioned, role }.
export async function memberOfOrg(svc, userId, organizationId) {
  if (!organizationId) return { ok: false, provisioned: true, role: null }
  const { data, error } = await svc
    .from('organization_members')
    .select('role, status')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) {
    if (error.code === '42P01') return { ok: false, provisioned: false, role: null }
    throw new Error('organization_members read: ' + error.message)
  }
  if (!data) return { ok: false, provisioned: true, role: null }
  return { ok: true, provisioned: true, role: data.role }
}

// Map an access visibility (from resolveAccess) to a task-service actor type.
export function actorTypeFor(access, teamRole) {
  if (!access) return null
  if (access.role === 'owner') return 'loan_officer'
  if (access.role === 'team') return teamRole === 'assistant' ? 'assistant' : 'processor'
  return access.visibility // borrower/coborrower/realtor/escrow/title
}
