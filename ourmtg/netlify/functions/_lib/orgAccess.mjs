// Phase 1C — loan-scoped organization and participant authorization helpers.
// Organization comes from loan_files.organization_id. Internal users must also be active members
// of that organization; borrowers/co-borrowers use the loan-specific portal_access grant.

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

export async function verifyBorrowerParticipant(svc, loanFileId, userId) {
  if (!loanFileId || !userId) return { ok: false }
  const { data, error } = await svc
    .from('portal_access')
    .select('visibility')
    .eq('loan_file_id', loanFileId).eq('portal_user', userId)
    .in('visibility', ['borrower', 'coborrower'])
    .maybeSingle()
  if (error) {
    if (error.code === '42P01') return { ok: false }
    throw new Error('portal_access read: ' + error.message)
  }
  return data ? { ok: true, visibility: data.visibility } : { ok: false }
}

export async function listBorrowerParticipants(svc, loanFileId) {
  const { data: grants, error } = await svc
    .from('portal_access')
    .select('portal_user, visibility')
    .eq('loan_file_id', loanFileId)
    .in('visibility', ['borrower', 'coborrower'])
  if (error) throw new Error('portal_access participants: ' + error.message)
  const ids = (grants || []).map((g) => g.portal_user)
  if (!ids.length) return []
  const { data: people, error: pErr } = await svc
    .from('portal_users')
    .select('id, full_name, email')
    .in('id', ids)
  if (pErr) throw new Error('portal_users participants: ' + pErr.message)
  const byId = new Map((people || []).map((p) => [p.id, p]))
  return (grants || []).map((g) => ({
    id: g.portal_user,
    visibility: g.visibility,
    name: byId.get(g.portal_user)?.full_name || null,
    email: byId.get(g.portal_user)?.email || null,
  }))
}

export async function verifyTaskDocument(svc, loanFileId, documentId) {
  if (!loanFileId || !documentId) return { ok: false }
  const { data, error } = await svc
    .from('loan_documents')
    .select('id, loan_file_id, doc_key, label, who, status')
    .eq('id', documentId)
    .eq('loan_file_id', loanFileId)
    .maybeSingle()
  if (error) throw new Error('loan_documents task binding: ' + error.message)
  return data ? { ok: true, document: data } : { ok: false }
}

export function actorTypeFor(access, teamRole) {
  if (!access) return null
  if (access.role === 'owner') return 'loan_officer'
  if (access.role === 'team') return teamRole === 'assistant' ? 'assistant' : 'processor'
  return access.visibility
}

export async function resolveTaskContext(svc, userId, loanFile, access) {
  const organizationId = loanFile?.organization_id || null
  if (!organizationId) return { ok: false, provisioned: false, error: 'not_provisioned' }
  if (!access) return { ok: false, provisioned: true, error: 'no_access' }
  const isInternal = access.role === 'owner' || access.role === 'team'
  const actorType = actorTypeFor(access, access.teamRole)

  if (isInternal) {
    const mem = await memberOfOrg(svc, userId, organizationId)
    if (!mem.provisioned) return { ok: false, provisioned: false, error: 'not_provisioned' }
    if (!mem.ok) return { ok: false, provisioned: true, error: 'not_org_member' }
    return { ok: true, provisioned: true, organizationId, isInternal: true, actorType }
  }
  if (access.visibility === 'borrower' || access.visibility === 'coborrower') {
    return { ok: true, provisioned: true, organizationId, isInternal: false, actorType }
  }
  return { ok: false, provisioned: true, error: 'forbidden_role' }
}
