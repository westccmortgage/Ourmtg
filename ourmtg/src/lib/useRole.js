// Detect what the signed-in user can do, since there's no server "who am I" endpoint:
//   • portal_access grants (RLS-readable) → borrower/co-borrower and/or realtor files
//   • portal-review-queue returning owned files → loan officer / owner
// A user is usually exactly one of these; we still surface all applicable roles so a
// tester who is both can switch. Returns { loading, error, roles, grants, ownedFiles }.
import { useEffect, useState } from 'react'
import { listMyGrants, getReviewQueue } from './api'

export function useRole() {
  const [state, setState] = useState({ loading: true, error: '', roles: [], grants: [], ownedFiles: [] })

  useEffect(() => {
    let alive = true
    async function run() {
      try {
        const [grants, queue] = await Promise.all([
          listMyGrants().catch(() => []),
          getReviewQueue().catch(() => ({ files: [] })),
        ])
        if (!alive) return
        const ownedFiles = queue?.files || []
        const roles = []
        if (grants.some((g) => g.visibility === 'borrower' || g.visibility === 'coborrower')) roles.push('borrower')
        if (grants.some((g) => g.visibility === 'realtor')) roles.push('realtor')
        if (ownedFiles.length) roles.push('lo')
        setState({ loading: false, error: '', roles, grants, ownedFiles })
      } catch (err) {
        if (alive) setState({ loading: false, error: err?.message || 'Could not load your portal.', roles: [], grants: [], ownedFiles: [] })
      }
    }
    run()
    return () => { alive = false }
  }, [])

  return state
}
