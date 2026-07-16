// Phase 1C EXT-1 — LOAN-SCOPED organization resolution. The organization is resolved from the
// LOAN FILE (loan_files.organization_id), not from the caller's arbitrary first membership.
//   • Internal (owner/team) users must ALSO be active members of the file's organization.
//   • Borrowers/co-borrowers use portal_access and do NOT require organization membership.
//   • Realtor/escrow/title are denied financial/document tasks.
// Membership is never inferred from an email domain. Users may belong to multiple organizations.

// Active membership check for a SPECIFIC org. { ok, provisioned, role }.
export async function memberOfOrg(svc, userId, organizationId) {
  if (!organizationId) return { ok: false, provisioned: true, role: null }
  const { data, error } = await svc
    .from('organization_members')
    .select('role, status')
    .eq('user_id', userId).eq('organization_id', organizationId).eq('status', 'active')
    .maybeSingle()
  if (error) {
    if (error.code === '42P01') return { ok: false, provisioned: false, role: null }
    throw new Error('organization_members read: ' + error.message)
  }
  if (!data) return { ok: false, provisioned: true, role: null }
  return { ok: true, provisioned: true, role: data.role }
}

// Map a resolveAccess result to a task-service actor type.
export function actorTypeFor(access, teamRole) {
  if (!access) return null
  if (access.role === 'owner') return 'loan_officer'
  if (access.role === 'team') return teamRole === 'assistant' ? 'assistant' : 'processor'
  return access.visibility // borrower/coborrower/realtor/escrow/title
}

// Resolve the full task-authorization context for a loan file + access grant.
// Returns { ok, provisioned, organizationId, isInternal, actorType, error }.
//   provisioned=false → the file has no organization_id (pilot not backfilled) → 503.
//   error='not_org_member' → internal user lacks membership in the file's org → 403.
//   error='forbidden_role' → realtor/escrow/title → 403.
export async function resolveTaskContext(svc, userId, loanFile, access) {
  const organizationId = loanFile?.organization_id || null
  if (!organizationId) return { ok: false, provisioned: false, error: 'not_provisioned' }
  if (!access) return { ok: false, provisioned: true, error: 'no_access' }
  const isInternal = access.role === 'owner' || access.role === 'team'
  const actorType = actorTypeFor(access, access.teamRole)

  if (isInternal) {
    const mem = await memberOfOrg(svc, userId, organizationId)
    if (!mem.provisioned) return { ok: false, provisioned: false, error: 'not_provisioned' }
    if (!mem.ok) return { ok: false, provisioned: true, error: 'not_org_member' } // EXT-1: internal MUST be a member
    return { ok: true, provisioned: true, organizationId, isInternal: true, actorType }
  }
  // Borrower / co-borrower: portal_access is sufficient, NO membership required (EXT-1).
  if (access.visibility === 'borrower' || access.visibility === 'coborrower') {
    return { ok: true, provisioned: true, organizationId, isInternal: false, actorType }
  }
  return { ok: false, provisioned: true, error: 'forbidden_role' } // realtor/escrow/title
}
