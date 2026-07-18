// Phase 1C EXT-1 — LOAN-SCOPED organization resolution. The org comes from the loan FILE, internal
// users must be active members of THAT org, borrowers/co-borrowers ride portal_access with no
// membership, realtor/escrow/title are denied, and users may belong to many orgs. Fake svc, no DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTaskContext, memberOfOrg, actorTypeFor, verifyBorrowerParticipant } from '../netlify/functions/_lib/orgAccess.mjs'

// Fake svc backed by an in-memory portal_access table (supports .eq + .in + maybeSingle).
function fakeAccessSvc(grants = []) {
  return {
    from() {
      const eqs = []; let inClause = null
      const b = {
        select() { return b },
        eq(k, v) { eqs.push([k, v]); return b },
        in(k, vals) { inClause = [k, vals]; return b },
        maybeSingle() {
          const row = grants.find((g) => eqs.every(([k, v]) => g[k] === v) && (!inClause || inClause[1].includes(g[inClause[0]])))
          return Promise.resolve({ data: row ? { visibility: row.visibility } : null, error: null })
        },
      }
      return b
    },
  }
}

// Fake Supabase svc backed by an in-memory organization_members table.
function fakeSvc(members = [], { tableMissing = false } = {}) {
  return {
    from(table) {
      const filters = []
      const b = {
        select() { return b },
        eq(k, v) { filters.push([k, v]); return b },
        maybeSingle() {
          if (tableMissing) return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } })
          if (table !== 'organization_members') return Promise.resolve({ data: null, error: null })
          const row = members.find((m) => filters.every(([k, v]) => m[k] === v))
          return Promise.resolve({ data: row || null, error: null })
        },
      }
      return b
    },
  }
}

const fileWcc = { id: 'file-1', organization_id: 'org-wcc' }
const ownerAccess = { role: 'owner', visibility: 'internal' }
const teamAccess = { role: 'team', visibility: 'internal', teamRole: 'processor' }
const borrowerAccess = { role: 'borrower', visibility: 'borrower' }
const coborrowerAccess = { role: 'coborrower', visibility: 'coborrower' }
const realtorAccess = { role: 'realtor', visibility: 'realtor' }

test('EXT-1: internal user WITH active membership in the file org resolves ok', async () => {
  const svc = fakeSvc([{ user_id: 'u-lo', organization_id: 'org-wcc', status: 'active', role: 'loan_officer' }])
  const ctx = await resolveTaskContext(svc, 'u-lo', fileWcc, ownerAccess)
  assert.equal(ctx.ok, true)
  assert.equal(ctx.isInternal, true)
  assert.equal(ctx.organizationId, 'org-wcc')
  assert.equal(ctx.actorType, 'loan_officer')
})

test('EXT-1: internal user WITHOUT membership in the file org is denied (not_org_member)', async () => {
  const svc = fakeSvc([]) // no membership rows
  const ctx = await resolveTaskContext(svc, 'u-lo', fileWcc, ownerAccess)
  assert.equal(ctx.ok, false)
  assert.equal(ctx.error, 'not_org_member')
})

test('EXT-1: borrower with portal_access resolves WITHOUT any org membership', async () => {
  const svc = fakeSvc([]) // deliberately no membership
  const ctx = await resolveTaskContext(svc, 'u-borrower', fileWcc, borrowerAccess)
  assert.equal(ctx.ok, true)
  assert.equal(ctx.isInternal, false)
  assert.equal(ctx.organizationId, 'org-wcc')
  assert.equal(ctx.actorType, 'borrower')
})

test('EXT-1: co-borrower likewise resolves via portal_access', async () => {
  const svc = fakeSvc([])
  const ctx = await resolveTaskContext(svc, 'u-co', fileWcc, coborrowerAccess)
  assert.equal(ctx.ok, true)
  assert.equal(ctx.actorType, 'coborrower')
})

test('EXT-1: realtor/escrow/title are denied (forbidden_role)', async () => {
  const svc = fakeSvc([])
  const ctx = await resolveTaskContext(svc, 'u-realtor', fileWcc, realtorAccess)
  assert.equal(ctx.ok, false)
  assert.equal(ctx.error, 'forbidden_role')
})

test('EXT-1: a file with no organization_id is unprovisioned (503 upstream)', async () => {
  const svc = fakeSvc([{ user_id: 'u-lo', organization_id: 'org-wcc', status: 'active', role: 'loan_officer' }])
  const ctx = await resolveTaskContext(svc, 'u-lo', { id: 'file-x', organization_id: null }, ownerAccess)
  assert.equal(ctx.ok, false)
  assert.equal(ctx.provisioned, false)
})

test('EXT-1: cross-org — membership in a DIFFERENT org does not grant access to this file', async () => {
  const svc = fakeSvc([{ user_id: 'u-lo', organization_id: 'org-OTHER', status: 'active', role: 'loan_officer' }])
  const ctx = await resolveTaskContext(svc, 'u-lo', fileWcc, ownerAccess) // file is org-wcc
  assert.equal(ctx.ok, false)
  assert.equal(ctx.error, 'not_org_member')
})

test('EXT-1: multi-org user is resolved against THE FILE\'s org, not an arbitrary one', async () => {
  const svc = fakeSvc([
    { user_id: 'u-multi', organization_id: 'org-A', status: 'active', role: 'loan_officer' },
    { user_id: 'u-multi', organization_id: 'org-wcc', status: 'active', role: 'processor' },
  ])
  const ctx = await resolveTaskContext(svc, 'u-multi', fileWcc, teamAccess)
  assert.equal(ctx.ok, true)
  assert.equal(ctx.organizationId, 'org-wcc') // resolved from the file
})

test('EXT-1: an inactive membership does not satisfy the internal member requirement', async () => {
  const svc = fakeSvc([{ user_id: 'u-lo', organization_id: 'org-wcc', status: 'disabled', role: 'loan_officer' }])
  const ctx = await resolveTaskContext(svc, 'u-lo', fileWcc, ownerAccess)
  assert.equal(ctx.ok, false)
  assert.equal(ctx.error, 'not_org_member')
})

test('memberOfOrg reports unprovisioned when the table is missing (42P01)', async () => {
  const svc = fakeSvc([], { tableMissing: true })
  const m = await memberOfOrg(svc, 'u', 'org-wcc')
  assert.equal(m.provisioned, false)
  assert.equal(m.ok, false)
})

// FCG #2: a targeted participant must be a VERIFIED borrower/co-borrower on THIS loan file.
test('FCG #2: verifyBorrowerParticipant accepts a real borrower/co-borrower on the file', async () => {
  const svc = fakeAccessSvc([
    { loan_file_id: 'f1', portal_user: 'b1', visibility: 'borrower' },
    { loan_file_id: 'f1', portal_user: 'c1', visibility: 'coborrower' },
    { loan_file_id: 'f1', portal_user: 'r1', visibility: 'realtor' },
  ])
  assert.equal((await verifyBorrowerParticipant(svc, 'f1', 'b1')).ok, true)
  assert.equal((await verifyBorrowerParticipant(svc, 'f1', 'c1')).ok, true)
})

test('FCG #2: verifyBorrowerParticipant rejects a non-borrower, a wrong file, and unknown users', async () => {
  const svc = fakeAccessSvc([
    { loan_file_id: 'f1', portal_user: 'r1', visibility: 'realtor' },
    { loan_file_id: 'f2', portal_user: 'b9', visibility: 'borrower' },
  ])
  assert.equal((await verifyBorrowerParticipant(svc, 'f1', 'r1')).ok, false) // realtor is not a borrower
  assert.equal((await verifyBorrowerParticipant(svc, 'f1', 'b9')).ok, false) // borrower, but on a DIFFERENT file
  assert.equal((await verifyBorrowerParticipant(svc, 'f1', 'ghost')).ok, false) // no grant at all
  assert.equal((await verifyBorrowerParticipant(svc, '', 'b1')).ok, false)     // missing args
})

test('actorTypeFor maps roles to task-service actor types', () => {
  assert.equal(actorTypeFor({ role: 'owner' }), 'loan_officer')
  assert.equal(actorTypeFor({ role: 'team' }, 'assistant'), 'assistant')
  assert.equal(actorTypeFor({ role: 'team' }, 'processor'), 'processor')
  assert.equal(actorTypeFor({ role: 'borrower', visibility: 'borrower' }), 'borrower')
})
