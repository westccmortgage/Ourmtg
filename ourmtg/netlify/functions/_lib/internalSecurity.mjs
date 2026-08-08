// Internal workspace step-up authentication.
//
// Borrowers and transaction partners keep their normal verified Supabase session. Anyone who
// operates mortgage files from inside the organization must present an AAL2 JWT whenever the
// rollout flag is enabled. Classification comes from server-owned relationships, never from a
// client role or user metadata claim.

import { serverFlag } from './featureFlags.mjs'

export function internalAal2Enabled(env = process.env) {
  return serverFlag('OURMTG_INTERNAL_AAL2_ENFORCED', env)
}

export function internalAal2Decision({ enabled, internal, aal }) {
  const mfaRequired = enabled === true && internal === true && aal !== 'aal2'
  return { allowed: !mfaRequired, mfaRequired }
}

async function exists(query, label, { allowMissingTable = false } = {}) {
  const { data, error } = await query.limit(1)
  // Direct Postgres reports 42P01; PostgREST reports PGRST205 when the table is absent from its
  // schema cache. Delta 043 is still review-only, so either shape means "not provisioned yet",
  // not a reason to lock every borrower out of the existing portal.
  if (allowMissingTable && ['42P01', 'PGRST205'].includes(error?.code)) return false
  if (error) throw new Error(`${label} read: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}

// A user is internal if any server-owned relationship makes them a file owner, legacy loan-team
// member, or active organization member. A borrower who is also staff is treated as staff.
export async function isInternalUser(svc, userId) {
  if (!userId) return false
  // Short-circuit known production relationships before touching the Phase 1C review-only table.
  if (await exists(svc.from('loan_files').select('id').eq('owner_user_id', userId), 'loan_files owner')) return true
  if (await exists(
    svc.from('portal_team').select('id').eq('member_user_id', userId),
    'portal_team member', { allowMissingTable: true },
  )) return true
  return exists(
    svc.from('organization_members').select('id').eq('user_id', userId).eq('status', 'active'),
    'organization_members member', { allowMissingTable: true },
  )
}
