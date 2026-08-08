// GET /.netlify/functions/portal-security-status
//
// Minimal bootstrap endpoint for the authenticated SPA. It intentionally verifies through
// userauth.getUser directly so an AAL1 staff member can learn that step-up is required. It returns
// no loan/customer data and cannot mutate anything. All other portal functions use authUser(),
// where AAL2 is enforced centrally for internal users when the rollout flag is enabled.

import { admin, isConfigured } from './_lib/supabase.mjs'
import { getUser } from './_lib/userauth.mjs'
import { json, preflight } from './_lib/portal.mjs'
import {
  internalAal2Decision, internalAal2Enabled, isInternalUser,
} from './_lib/internalSecurity.mjs'

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)
  if (!isConfigured()) return json({ ok: false, error: 'Service not configured' }, 503)

  const auth = await getUser(req)
  if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401)

  try {
    const internal = await isInternalUser(admin(), auth.user.id)
    const enforcementEnabled = internalAal2Enabled()
    const decision = internalAal2Decision({ enabled: enforcementEnabled, internal, aal: auth.aal })
    return json({
      ok: true,
      internal,
      aal: auth.aal,
      enforcementEnabled,
      mfaRequired: decision.mfaRequired,
    })
  } catch (error) {
    console.error('[portal-security-status]', error?.message || error)
    return json({ ok: false, error: 'Could not verify workspace security' }, 503)
  }
}
