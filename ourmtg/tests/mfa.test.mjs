import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'

// userauth reads the Supabase URL/key at module initialization, just like it does in a Netlify
// worker. Configure the isolated fake before importing that module.
setTestEnv()
const {
  authenticatorAssuranceLevel, claimsFromVerifiedJwt,
} = await import('../netlify/functions/_lib/userauth.mjs')
const {
  internalAal2Decision, internalAal2Enabled, isInternalUser,
} = await import('../netlify/functions/_lib/internalSecurity.mjs')

const LOAN = '11111111-1111-4111-8111-111111111111'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BORROWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.test-signature`
}

const OWNER_AAL1 = jwt({ sub: OWNER, aal: 'aal1' })
const OWNER_AAL2 = jwt({ sub: OWNER, aal: 'aal2' })
const BORROWER_AAL1 = jwt({ sub: BORROWER, aal: 'aal1' })

const USERS = {
  [OWNER_AAL1]: { id: OWNER, email: 'lo@example.com', aud: 'authenticated' },
  [OWNER_AAL2]: { id: OWNER, email: 'lo@example.com', aud: 'authenticated' },
  [BORROWER_AAL1]: { id: BORROWER, email: 'borrower@example.com', aud: 'authenticated' },
}

const tables = () => ({
  loan_files: [{
    id: LOAN, owner_user_id: OWNER, borrower_name: 'Borrower', stage: 'lead',
    loan_type: 'Conventional', purpose: 'purchase', amount: 500000,
  }],
  portal_team: [{ id: 'team-row', owner_user_id: OWNER, member_user_id: TEAM, role: 'processor' }],
  organization_members: [],
  portal_access: [{ loan_file_id: LOAN, portal_user: BORROWER, visibility: 'borrower' }],
  portal_access_log: [],
})

function install(fake) {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  return () => { globalThis.fetch = original }
}

test('verified-JWT claim decoding treats only exact aal2 as elevated', () => {
  assert.equal(claimsFromVerifiedJwt(OWNER_AAL2).sub, OWNER)
  assert.equal(authenticatorAssuranceLevel(OWNER_AAL2), 'aal2')
  assert.equal(authenticatorAssuranceLevel(OWNER_AAL1), 'aal1')
  assert.equal(authenticatorAssuranceLevel(jwt({ aal: 'AAL2' })), 'aal1')
  assert.equal(authenticatorAssuranceLevel('not-a-jwt'), 'aal1')
})

test('internal AAL2 decision is strict, default-off, and borrower-safe', () => {
  assert.equal(internalAal2Enabled({}), false)
  assert.equal(internalAal2Enabled({ OURMTG_INTERNAL_AAL2_ENFORCED: 'true' }), true)
  assert.deepEqual(internalAal2Decision({ enabled: true, internal: true, aal: 'aal1' }), {
    allowed: false, mfaRequired: true,
  })
  assert.equal(internalAal2Decision({ enabled: true, internal: true, aal: 'aal2' }).allowed, true)
  assert.equal(internalAal2Decision({ enabled: true, internal: false, aal: 'aal1' }).allowed, true)
})

test('internal classification uses server-owned owner/team/org relationships', async () => {
  const fake = createFakeSupabase({ tables: {
    ...tables(),
    organization_members: [{ id: 'org-row', user_id: 'org-user', organization_id: 'org-1', status: 'active' }],
  } })
  const { createClient } = await import('@supabase/supabase-js')
  setTestEnv()
  const restore = install(fake)
  try {
    const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
    assert.equal(await isInternalUser(svc, OWNER), true)
    assert.equal(await isInternalUser(svc, TEAM), true)
    assert.equal(await isInternalUser(svc, 'org-user'), true)
    assert.equal(await isInternalUser(svc, BORROWER), false)
  } finally { restore() }
})

test('missing rollout tables degrade safely, while real classification errors fail closed', async () => {
  function svcWith(resultFor) {
    return {
      from(table) {
        const query = {
          select() { return query }, eq() { return query },
          limit() { return Promise.resolve(resultFor(table)) },
        }
        return query
      },
    }
  }
  const missing = svcWith((table) => table === 'loan_files'
    ? { data: [], error: null }
    : { data: null, error: { code: 'PGRST205', message: 'table is absent from schema cache' } })
  assert.equal(await isInternalUser(missing, BORROWER), false)

  const broken = svcWith((table) => table === 'loan_files'
    ? { data: null, error: { code: '08006', message: 'connection failed' } }
    : { data: [], error: null })
  await assert.rejects(() => isInternalUser(broken, BORROWER), /loan_files owner read/)
})

test('security status with enforcement OFF has no classification-table dependency', async () => {
  setTestEnv({ OURMTG_INTERNAL_AAL2_ENFORCED: 'false' })
  const fake = createFakeSupabase({ tables: {}, users: USERS })
  const restore = install(fake)
  try {
    const handler = (await import(`../netlify/functions/portal-security-status.mjs?off=${Date.now()}`)).default
    const response = await handler(makeRequest(
      'https://app.test/.netlify/functions/portal-security-status',
      { token: BORROWER_AAL1 },
    ))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true, internal: null, aal: 'aal1', enforcementEnabled: false, mfaRequired: false,
    })
    assert.equal(fake.calls.filter((call) => call.path.startsWith('/rest/v1/')).length, 0)
  } finally { restore() }
})

test('security status requires AAL2 for staff but not for borrowers', async () => {
  setTestEnv({ OURMTG_INTERNAL_AAL2_ENFORCED: 'true' })
  const fake = createFakeSupabase({ tables: tables(), users: USERS })
  const restore = install(fake)
  try {
    const handler = (await import(`../netlify/functions/portal-security-status.mjs?mfa=${Date.now()}`)).default
    const url = 'https://app.test/.netlify/functions/portal-security-status'

    const ownerAal1 = await handler(makeRequest(url, { token: OWNER_AAL1 }))
    assert.equal(ownerAal1.status, 200)
    assert.deepEqual(await ownerAal1.json(), {
      ok: true, internal: true, aal: 'aal1', enforcementEnabled: true, mfaRequired: true,
    })

    const ownerAal2 = await handler(makeRequest(url, { token: OWNER_AAL2 }))
    assert.equal((await ownerAal2.json()).mfaRequired, false)

    const borrower = await handler(makeRequest(url, { token: BORROWER_AAL1 }))
    assert.deepEqual(await borrower.json(), {
      ok: true, internal: false, aal: 'aal1', enforcementEnabled: true, mfaRequired: false,
    })
  } finally { restore() }
})

test('central portal auth blocks staff AAL1 while preserving borrower AAL1', async () => {
  setTestEnv({ OURMTG_INTERNAL_AAL2_ENFORCED: 'true' })
  const fake = createFakeSupabase({ tables: tables(), users: USERS })
  const restore = install(fake)
  try {
    const handler = (await import(`../netlify/functions/portal-status.mjs?mfa=${Date.now()}`)).default
    const url = `https://app.test/.netlify/functions/portal-status?loanFileId=${LOAN}`
    assert.equal((await handler(makeRequest(url, { token: OWNER_AAL1 }))).status, 401)
    assert.equal((await handler(makeRequest(url, { token: OWNER_AAL2 }))).status, 200)
    assert.equal((await handler(makeRequest(url, { token: BORROWER_AAL1 }))).status, 200)
  } finally { restore() }
})

test('SPA workspace routes use the MFA-aware gate and security is the only bootstrap exemption', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const portal = readFileSync(new URL('../netlify/functions/_lib/portal.mjs', import.meta.url), 'utf8')
  const security = readFileSync(new URL('../netlify/functions/portal-security-status.mjs', import.meta.url), 'utf8')
  assert.match(app, /path="security" element={<RequireAuth><SecuritySetup/)
  assert.match(app, /path="portal" element={<RequireWorkspaceSecurity>/)
  assert.match(app, /pre-underwriting[\s\S]+RequireWorkspaceSecurity/)
  assert.match(portal, /isInternalUser\(admin\(\), auth\.user\.id\)/)
  assert.match(security, /import \{ getUser \} from '.\/_lib\/userauth\.mjs'/)
  assert.doesNotMatch(security, /authUser\(req\)/)
  const panel = readFileSync(new URL('../netlify/functions/pre-underwriting-review.mjs', import.meta.url), 'utf8')
  assert.match(panel, /OURMTG_INTERNAL_AAL2_ENFORCED'[\s\S]+OURMTG_INTERNAL_AAL2_ACCEPTED'/)
})
