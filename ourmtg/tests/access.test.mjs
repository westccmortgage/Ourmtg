// Role/authorization tests for resolveAccess using an INJECTED fake Supabase client — no
// network, no production Supabase (Phase 1A §6). Proves the server-side access decisions.
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveAccess, isInternal, canSeeFinancials } from '../netlify/functions/_lib/portal.mjs'

// Minimal chainable fake: .from(table).select(...).eq(...).eq(...).maybeSingle() → configured result.
function fakeSvc(byTable) {
  return {
    from(table) {
      const result = byTable[table] || { data: null, error: null }
      const chain = {
        select() { return chain },
        eq() { return chain },
        in() { return chain },
        order() { return chain },
        limit() { return Promise.resolve(result) },
        maybeSingle() { return Promise.resolve(result) },
        then(res) { return Promise.resolve(result).then(res) }, // awaitable directly
      }
      return chain
    },
  }
}

const OWNER = 'owner-uuid'
const FILE = { id: 'file-1', owner_user_id: OWNER }

test('owner short-circuit: caller.id === owner_user_id → full internal access', async () => {
  const access = await resolveAccess(fakeSvc({}), OWNER, FILE)
  assert.deepEqual(access, { role: 'owner', visibility: 'owner', loanFile: FILE })
  assert.equal(isInternal(access), true)
  assert.equal(canSeeFinancials(access.visibility), true)
})

test('team member of the owner → internal access (visibility owner)', async () => {
  const svc = fakeSvc({ portal_team: { data: { role: 'processor' }, error: null } })
  const access = await resolveAccess(svc, 'processor-uuid', FILE)
  assert.equal(access.role, 'team')
  assert.equal(access.visibility, 'owner')
  assert.equal(access.teamRole, 'processor')
  assert.equal(isInternal(access), true)
})

test('borrower grant → portal access, NOT internal, can see financials', async () => {
  const svc = fakeSvc({
    portal_team: { data: null, error: null },
    portal_access: { data: { visibility: 'borrower' }, error: null },
  })
  const access = await resolveAccess(svc, 'borrower-uuid', FILE)
  assert.equal(access.role, 'portal')
  assert.equal(access.visibility, 'borrower')
  assert.equal(isInternal(access), false)          // cannot reach internal review endpoints
  assert.equal(canSeeFinancials(access.visibility), true)
})

test('realtor grant → cannot see financials, not internal', async () => {
  const svc = fakeSvc({
    portal_team: { data: null, error: null },
    portal_access: { data: { visibility: 'realtor' }, error: null },
  })
  const access = await resolveAccess(svc, 'realtor-uuid', FILE)
  assert.equal(access.visibility, 'realtor')
  assert.equal(canSeeFinancials(access.visibility), false) // structurally blocked from docs/conditions
  assert.equal(isInternal(access), false)
})

test('no grant (e.g. guessed loan-file id by a stranger) → null (denied)', async () => {
  const svc = fakeSvc({
    portal_team: { data: null, error: null },
    portal_access: { data: null, error: null },
  })
  const access = await resolveAccess(svc, 'stranger-uuid', FILE)
  assert.equal(access, null) // another borrower / random user gets nothing
})

test('borrower of file A cannot resolve access to file B they lack a grant for', async () => {
  // Same stranger path but framed as cross-file isolation: no portal_access row for this file.
  const svc = fakeSvc({
    portal_team: { data: null, error: null },
    portal_access: { data: null, error: null },
  })
  assert.equal(await resolveAccess(svc, 'borrower-of-other-file', FILE), null)
})

test('missing portal_team table (42P01) degrades gracefully, still resolves portal grant', async () => {
  const svc = fakeSvc({
    portal_team: { data: null, error: { code: '42P01', message: 'relation does not exist' } },
    portal_access: { data: { visibility: 'coborrower' }, error: null },
  })
  const access = await resolveAccess(svc, 'coborrower-uuid', FILE)
  assert.equal(access.role, 'portal')
  assert.equal(access.visibility, 'coborrower')
})

test('null loan file → null access', async () => {
  assert.equal(await resolveAccess(fakeSvc({}), OWNER, null), null)
})
