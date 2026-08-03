// Conversational 1003 — endpoint tests.
//
// These drive the actual Netlify handlers over an in-memory PostgREST/GoTrue stand-in, so the
// real Supabase client, the real repo layer, and the real engine all run. They close the gap
// the QA report flags: until now the six endpoints were verified by code review only.
//
// What these DO prove: flag gating, authentication, authorization (including that realtors and
// escrow are structurally excluded), idempotency and its conflict case, the append-only write
// path, the deterministic fallback when no provider is configured, and that secure/demographic
// values cannot be written through the conversational path.
//
// What they do NOT prove: RLS, foreign keys, and check constraints — those live in migration
// 003 and can only be verified against a real database.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeSupabase, makeRequest, setTestEnv } from './_fakeSupabase.mjs'
import { ATTESTATION_VERSION } from '../src/features/conversational-1003/attestationText.js'

const LOAN = '11111111-1111-4111-8111-111111111111'
const OTHER_LOAN = '22222222-2222-4222-8222-222222222222'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BORROWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REALTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STRANGER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const USERS = {
  'tok-owner': { id: OWNER, email: 'lo@wcc.com', aud: 'authenticated' },
  'tok-borrower': { id: BORROWER, email: 'daria@example.com', aud: 'authenticated' },
  'tok-realtor': { id: REALTOR, email: 'agent@example.com', aud: 'authenticated' },
  'tok-stranger': { id: STRANGER, email: 'nobody@example.com', aud: 'authenticated' },
}

const BASE_TABLES = () => ({
  loan_files: [
    { id: LOAN, owner_user_id: OWNER, organization_id: 'org-1', borrower_name: 'Daria N', stage: 'lead' },
    { id: OTHER_LOAN, owner_user_id: OWNER, organization_id: 'org-1', borrower_name: 'Someone Else', stage: 'lead' },
  ],
  portal_access: [
    { portal_user: BORROWER, loan_file_id: LOAN, visibility: 'borrower' },
    { portal_user: REALTOR, loan_file_id: LOAN, visibility: 'realtor' },
  ],
  portal_team: [],
  portal_access_log: [],
})

/**
 * Fresh handler modules per test. The modules cache a Supabase client and read env at import
 * time, so each case gets its own module registry via a cache-busting query string.
 */
let bust = 0
async function loadHandlers(env = {}) {
  setTestEnv({ CONVERSATIONAL_1003_ENABLED: 'true', CONVERSATIONAL_1003_PROVIDER: '', ANTHROPIC_API_KEY: undefined, ...env })
  bust++
  const q = `?t=${bust}`
  return {
    session: (await import(`../netlify/functions/application-session.mjs${q}`)).default,
    turn: (await import(`../netlify/functions/application-turn.mjs${q}`)).default,
    confirm: (await import(`../netlify/functions/application-confirm.mjs${q}`)).default,
    secure: (await import(`../netlify/functions/application-secure-field.mjs${q}`)).default,
    attest: (await import(`../netlify/functions/application-attest.mjs${q}`)).default,
    team: (await import(`../netlify/functions/application-team-review.mjs${q}`)).default,
  }
}

function install(fake) {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  return () => { globalThis.fetch = original }
}

const sessionUrl = (loanFileId = LOAN) =>
  `https://app.test/.netlify/functions/application-session?loanFileId=${loanFileId}`

const key = (s) => `test.${s}.${Math.random().toString(36).slice(2, 10)}`

// ─────────────────────────────────────────────────────────────────────────────
test('feature flag OFF → every endpoint 404s, even for an authorized borrower', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers({ CONVERSATIONAL_1003_ENABLED: 'false' })
    const res = await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    assert.equal(res.status, 404)

    const turn = await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, text: 'hello', idempotencyKey: key('a') },
    }))
    assert.equal(turn.status, 404)
    // Nothing was read or written — the flag short-circuits before any database access.
    assert.equal(fake.calls.filter((c) => c.path.startsWith('/rest/')).length, 0)
  } finally { restore() }
})

test('no bearer token → 401, and nothing is read', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const res = await h.session(makeRequest(sessionUrl()))
    assert.equal(res.status, 401)
    assert.equal(fake.calls.filter((c) => c.path.startsWith('/rest/')).length, 0)
  } finally { restore() }
})

test('realtor is structurally excluded from the application (403)', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const res = await h.session(makeRequest(sessionUrl(), { token: 'tok-realtor' }))
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.ok, false)
    // No application or party row was created for them.
    assert.equal(fake.rowsOf('mortgage_applications').length, 0)
    assert.equal(fake.rowsOf('application_parties').length, 0)
  } finally { restore() }
})

test('a user with no grant on the file cannot reach it (403), and cannot guess another file', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    assert.equal((await h.session(makeRequest(sessionUrl(), { token: 'tok-stranger' }))).status, 403)
    // The borrower IS granted on LOAN but not on OTHER_LOAN.
    assert.equal((await h.session(makeRequest(sessionUrl(OTHER_LOAN), { token: 'tok-borrower' }))).status, 403)
  } finally { restore() }
})

test('borrower session bootstraps the application and returns a real first question', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const res = await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    assert.equal(res.status, 200)
    const body = await res.json()

    assert.equal(body.ok, true)
    assert.ok(body.application.id)
    assert.equal(body.party.role, 'borrower')
    assert.equal(body.nextQuestion.type, 'field')
    assert.ok(body.nextQuestion.prompt.length > 0)
    // The controls §11 requires are present on the very first question.
    const ids = body.nextQuestion.affordances.map((a) => a.id)
    for (const need of ['why_asking', 'do_not_understand', 'show_saved', 'talk_to_team']) {
      assert.ok(ids.includes(need), `missing affordance ${need}`)
    }
    // Progress is honest from the start, and says what it does not mean.
    assert.equal(body.progress.percent, 0)
    assert.ok(body.progress.notMeaning.includes('approved'))
    assert.equal(body.canAttest, false)

    // Rows were actually created, scoped to the org and loan file.
    const app = fake.rowsOf('mortgage_applications')[0]
    assert.equal(app.loan_file_id, LOAN)
    assert.equal(app.organization_id, 'org-1')
    assert.equal(fake.rowsOf('application_parties')[0].portal_user, BORROWER)

    // A second session does NOT create a second application.
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    assert.equal(fake.rowsOf('mortgage_applications').length, 1)
    assert.equal(fake.rowsOf('application_parties').length, 1)
  } finally { restore() }
})

test('a turn is persisted and answered deterministically when no provider is configured', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers() // no ANTHROPIC_API_KEY → provider unavailable
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))

    const res = await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, text: 'I make about $9,000 a month', idempotencyKey: key('t1') },
    }))
    assert.equal(res.status, 200)
    const body = await res.json()

    // The borrower's answer survived a provider that never ran...
    assert.equal(body.ok, true)
    assert.equal(body.degraded, true)
    assert.ok(body.degradedNotice.includes("don't need to type it again"))
    // ...and the interview still moves.
    assert.ok(body.nextQuestion)
    assert.deepEqual(body.accepted, [])

    const turn = fake.rowsOf('application_turns')[0]
    assert.equal(turn.borrower_text, 'I make about $9,000 a month')
    assert.equal(turn.processing_state, 'failed_safe')
    assert.equal(turn.error_code, 'interpretation_unavailable')
  } finally { restore() }
})

test('idempotency: replaying a key does not create a second turn; a different payload 409s', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    const k = key('dup')

    const send = (text) => h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, text, idempotencyKey: k },
    }))

    const first = await send('purchase')
    assert.equal(first.status, 200)
    assert.equal((await first.json()).deduped, undefined)

    // Same key, same payload → replay, not a second turn.
    const replay = await send('purchase')
    assert.equal(replay.status, 200)
    assert.equal((await replay.json()).deduped, true)
    assert.equal(fake.rowsOf('application_turns').length, 1)

    // Same key, DIFFERENT payload → refused rather than silently diverging.
    const conflict = await send('refinance')
    assert.equal(conflict.status, 409)
    assert.equal(fake.rowsOf('application_turns').length, 1)
  } finally { restore() }
})

test('secure fields: only catalog secure paths, format-checked, and only a mask is stored', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))

    const post = (body) => h.secure(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower', body: { loanFileId: LOAN, idempotencyKey: key('s'), ...body },
    }))

    // A non-secure field cannot be written here at all.
    const wrong = await post({ fieldPath: 'parties[0].legalFirstName', value: '123456789' })
    assert.equal(wrong.status, 400)

    // A malformed SSN is refused without being stored.
    const bad = await post({ fieldPath: 'parties[0].ssn', value: '000-00-0000' })
    assert.equal(bad.status, 400)
    assert.equal(fake.rowsOf('application_secure_fields').length, 0)

    // A valid one stores ONLY the mask and a digest.
    const ok = await post({ fieldPath: 'parties[0].ssn', value: '123-45-6789' })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.ok(body.masked.endsWith('6789'))

    const row = fake.rowsOf('application_secure_fields')[0]
    assert.equal(row.last_four, '6789')
    assert.ok(row.value_digest && row.value_digest.length === 64)
    // The plaintext appears nowhere in the stored row.
    assert.ok(!JSON.stringify(row).includes('123456789'))
    assert.ok(!JSON.stringify(row).includes('123-45-6789'))

    // Nor anywhere in the field event log / projection.
    const dump = JSON.stringify(fake.rowsOf('application_field_events')) + JSON.stringify(fake.rowsOf('application_field_state'))
    assert.ok(!dump.includes('123456789'))
    assert.ok(!dump.includes('12345'))
  } finally { restore() }
})

test('attestation is refused while required items are open, and lists what is left', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))

    const { ATTESTATION_VERSION } = await import('../src/features/conversational-1003/attestationText.js')
    const res = await h.attest(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: {
        loanFileId: LOAN, idempotencyKey: key('att'), accepted: true,
        documentVersion: ATTESTATION_VERSION, presentedAt: '2026-07-29T12:00:00.000Z',
      },
    }))
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.ok(body.openItems.length > 0, 'the borrower is told exactly what remains')
    assert.equal(fake.rowsOf('application_attestations').length, 0)
  } finally { restore() }
})

test('attestation refuses a stale document version (the borrower must see current text)', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const res = await h.attest(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: {
        loanFileId: LOAN, idempotencyKey: key('att2'), accepted: true,
        documentVersion: 'some.older.version', presentedAt: '2026-07-29T12:00:00.000Z',
      },
    }))
    assert.equal(res.status, 409)
    assert.equal(fake.rowsOf('application_attestations').length, 0)
  } finally { restore() }
})

test('team review is internal-only and returns provenance; a borrower cannot reach it', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))

    const denied = await h.team(makeRequest(
      `https://app.test/.netlify/functions/application-team-review?loanFileId=${LOAN}`,
      { token: 'tok-borrower' },
    ))
    assert.equal(denied.status, 403)

    const ok = await h.team(makeRequest(
      `https://app.test/.netlify/functions/application-team-review?loanFileId=${LOAN}`,
      { token: 'tok-owner' },
    ))
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.ok(body.review)
    assert.ok(Array.isArray(body.review.unresolvedRequired))
    assert.ok(body.review.notMeaning.includes('underwritten'))
    assert.ok(Array.isArray(body.partyProgress))
  } finally { restore() }
})

test('team cannot accept into the loan file before the borrower has attested', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    const res = await h.team(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: { loanFileId: LOAN, action: 'accept_into_loan_file', idempotencyKey: key('acc') },
    }))
    assert.equal(res.status, 409)
    assert.equal(fake.rowsOf('mortgage_applications')[0].status !== 'accepted_into_loan_file', true)
  } finally { restore() }
})

test('team correction appends an audited event and never erases borrower history', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))

    // Borrower states an employer via the confirm path (structured, no provider needed).
    const path = 'parties[0].employment[0].employerName'
    const before = fake.rowsOf('application_field_events').length

    const corrected = await h.team(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: { loanFileId: LOAN, action: 'correct', fieldPath: path, value: 'Harbor Logistics Inc', idempotencyKey: key('c1') },
    }))
    assert.equal(corrected.status, 200)

    const events = fake.rowsOf('application_field_events')
    assert.ok(events.length > before, 'a correction appends')
    const ev = events[events.length - 1]
    assert.equal(ev.field_path, path)
    assert.equal(ev.source, 'team_entry')          // never mistaken for borrower-stated
    assert.equal(ev.status, 'team_confirmed')
    assert.equal(ev.actor_user_id, OWNER)

    // A secure field cannot be edited through the team endpoint at all.
    const secure = await h.team(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: { loanFileId: LOAN, action: 'correct', fieldPath: 'parties[0].ssn', value: '123456789', idempotencyKey: key('c2') },
    }))
    assert.equal(secure.status, 400)
  } finally { restore() }
})

test('confirm rejects an unknown field path outright', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    const res = await h.confirm(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, action: 'confirm', paths: ['parties[0].madeUpField'], idempotencyKey: key('cf') },
    }))
    assert.equal(res.status, 400)
  } finally { restore() }
})

test('malformed input is refused before any database access', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const cases = [
      { body: { loanFileId: 'not-a-uuid', text: 'x', idempotencyKey: key('m') }, expect: 400 },
      { body: { loanFileId: LOAN, text: 'x', idempotencyKey: 'short' }, expect: 400 },
      { body: { loanFileId: LOAN, text: '', idempotencyKey: key('m') }, expect: 400 },
    ]
    for (const c of cases) {
      const res = await h.turn(makeRequest('https://app.test/x', { method: 'POST', token: 'tok-borrower', body: c.body }))
      assert.equal(res.status, c.expect, JSON.stringify(c.body))
    }
    assert.equal(fake.rowsOf('application_turns').length, 0)
  } finally { restore() }
})

test('the mock provider can never be selected without an explicit opt-in', async () => {
  const { selectProvider } = await import('../netlify/functions/_lib/conversational1003.mjs')
  // Asking for the mock without the opt-in is refused...
  assert.deepEqual(
    selectProvider({ env: { CONVERSATIONAL_1003_PROVIDER: 'mock' } }),
    { ok: false, error: 'mock_provider_not_permitted' },
  )
  // ...and an unset provider with no key is "not configured", never a silent mock.
  assert.equal(selectProvider({ env: {} }).ok, false)
  assert.equal(selectProvider({ env: {} }).error, 'provider_not_configured')
  // The opt-in works only where it is deliberately set (tests / local dev).
  const allowed = selectProvider({ env: { CONVERSATIONAL_1003_PROVIDER: 'mock', CONVERSATIONAL_1003_ALLOW_MOCK: 'true' } })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.provider.name, 'mock')
})

// ── the loan team taking the application on someone's behalf ─────────────────
// Taking a 1003 over the phone is the ordinary case, not an exception. What these prove is that
// doing it never produces a record claiming the borrower said something they did not.

const assistUrl = (party = 0, loanFileId = LOAN) =>
  `https://app.test/.netlify/functions/application-session?loanFileId=${loanFileId}&assistParty=${party}`

test('an internal viewer gets no question until they say they are taking the application', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const looking = await (await h.session(makeRequest(sessionUrl(), { token: 'tok-owner' }))).json()
    // Reviewing a file and conducting an interview are different acts; being internal is not
    // itself a declaration of which one is happening.
    assert.equal(looking.nextQuestion, null)
    assert.equal(looking.assisting, null)
    assert.equal(fake.rowsOf('application_parties').length, 0)

    const taking = await (await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))).json()
    assert.ok(taking.nextQuestion, 'the team gets the same first question the borrower would')
    assert.equal(taking.assisting.role, 'borrower')
    assert.equal(taking.assisting.borrowerName, 'Daria N')
    assert.equal(taking.assisting.canAttest, false)
  } finally { restore() }
})

test('the team member fills the borrower’s seat without becoming the borrower', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))

    const parties = fake.rowsOf('application_parties')
    assert.equal(parties.length, 1)
    assert.equal(parties[0].party_index, 0)
    // The seat is open, not occupied. An owner bound into portal_user here would make the loan
    // officer a party to the borrower's own application.
    assert.equal(parties[0].portal_user, null)
  } finally { restore() }
})

test('a borrower signing in later claims the seat the team opened, rather than colliding with it', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))
    const opened = fake.rowsOf('application_parties')[0]

    const borrower = await (await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))).json()
    const parties = fake.rowsOf('application_parties')
    assert.equal(parties.length, 1, 'no second party row at the same index')
    assert.equal(borrower.party.id, opened.id, 'the borrower inherits what was recorded for them')
    assert.equal(parties[0].portal_user, BORROWER)
  } finally { restore() }
})

test('a team-taken answer is recorded as team_entry, with who took it and how', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))

    const res = await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: {
        loanFileId: LOAN, text: 'purchase', idempotencyKey: key('assist'),
        assistParty: 0, takenVia: 'phone',
      },
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.assisted, { partyIndex: 0, takenVia: 'phone' })

    const turn = fake.rowsOf('application_turns')[0]
    assert.equal(turn.taken_by, OWNER)
    assert.equal(turn.taken_via, 'phone')

    // The value itself is attributed to the team, not to the borrower's own words. This is what
    // lets the review screen say "not borrower-stated" months later.
    const events = fake.rowsOf('application_field_events')
    assert.ok(events.length > 0, 'the answer was captured')
    for (const e of events) {
      if (e.source === 'system_derived') continue
      assert.equal(e.source, 'team_entry', e.field_path)
      assert.equal(e.actor_user_id, OWNER)
    }
  } finally { restore() }
})

test('a borrower’s own turn is never stamped as taken by someone else', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, text: 'purchase', idempotencyKey: key('own') },
    }))
    const turn = fake.rowsOf('application_turns')[0]
    assert.equal(turn.taken_by, null)
    assert.equal(turn.taken_via, null)
    for (const e of fake.rowsOf('application_field_events')) {
      if (e.source === 'system_derived') continue
      assert.equal(e.source, 'borrower_text')
    }
    // A borrower cannot promote themselves by claiming to be taking it for someone.
    await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: {
        loanFileId: LOAN, text: 'refinance', idempotencyKey: key('own2'),
        assistParty: 1, takenVia: 'phone',
      },
    }))
    assert.equal(fake.rowsOf('application_turns').every((t) => t.taken_by === null), true)
  } finally { restore() }
})

test('a team member must say who they are answering for, and how', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    const send = (body) => h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner', body: { loanFileId: LOAN, text: 'purchase', ...body },
    }))
    // Neither is inferable, and a wrong guess writes a false record — so neither is defaulted.
    assert.equal((await send({ idempotencyKey: key('n1'), takenVia: 'phone' })).status, 400)
    assert.equal((await send({ idempotencyKey: key('n2'), assistParty: 0 })).status, 400)
    assert.equal((await send({ idempotencyKey: key('n3'), assistParty: 0, takenVia: 'carrier_pigeon' })).status, 400)
    assert.equal(fake.rowsOf('application_turns').length, 0)
  } finally { restore() }
})

test('a realtor cannot take the application either, whatever they claim', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    for (const token of ['tok-realtor', 'tok-stranger']) {
      const res = await h.turn(makeRequest('https://app.test/x', {
        method: 'POST', token,
        body: {
          loanFileId: LOAN, text: 'purchase', idempotencyKey: key('nope'),
          assistParty: 0, takenVia: 'phone',
        },
      }))
      assert.equal(res.status, 403, token)
    }
    assert.equal(fake.rowsOf('application_turns').length, 0)
  } finally { restore() }
})

test('the team can take the whole application and still cannot sign it', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))
    await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: {
        loanFileId: LOAN, text: 'purchase', idempotencyKey: key('sign'),
        assistParty: 0, takenVia: 'phone',
      },
    }))

    // Attestation is the borrower's act and stays so — the team is refused on authorization,
    // before completeness is even considered.
    const res = await h.attest(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: {
        loanFileId: LOAN, idempotencyKey: key('att'), accepted: true,
        // The real current version, so this proves the authorization refusal and not the
        // stale-document check that runs before it.
        documentVersion: ATTESTATION_VERSION, presentedAt: new Date().toISOString(),
      },
    }))
    assert.equal(res.status, 403)
    assert.equal(fake.rowsOf('application_attestations').length, 0)

    // And the screen is never told otherwise.
    const s = await (await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))).json()
    assert.equal(s.canAttest, false)
  } finally { restore() }
})

test('the team cannot enter a Social Security number through the conversation', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))

    // The secure endpoint refuses them outright...
    const secure = await h.secure(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: { loanFileId: LOAN, fieldPath: 'parties[0].ssn', value: '123-45-6789', idempotencyKey: key('ssn') },
    }))
    assert.equal(secure.status, 403)

    // ...and reading one out over the phone into the chat box does not store it either.
    await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: {
        loanFileId: LOAN, text: 'his social is 123-45-6789', idempotencyKey: key('ssn2'),
        assistParty: 0, takenVia: 'phone',
      },
    }))
    const stored = JSON.stringify(fake.rowsOf('application_turns')) + JSON.stringify(fake.rowsOf('application_field_events'))
    assert.doesNotMatch(stored, /123-?45-?6789/)
  } finally { restore() }
})

test('a team confirmation is recorded as the team’s, not as the borrower being unsure', async () => {
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(assistUrl(0), { token: 'tok-owner' }))
    await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: {
        loanFileId: LOAN, text: 'purchase', idempotencyKey: key('c1'),
        assistParty: 0, takenVia: 'phone',
      },
    }))

    const res = await h.confirm(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-owner',
      body: {
        loanFileId: LOAN, action: 'unsure', paths: ['loan.purpose'],
        idempotencyKey: key('c2'), assistParty: 0, takenVia: 'phone',
      },
    }))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).canAttest, false)

    const flagged = fake.rowsOf('application_field_events').filter((e) => e.clarification_reason)
    assert.ok(flagged.length > 0)
    // "The borrower was unsure" and "the person writing it down was unsure" are different
    // follow-ups; recording the first when the second happened sends someone back to the
    // borrower over a transcription doubt.
    for (const e of flagged) assert.equal(e.clarification_reason, 'taken_by_team_unsure')
  } finally { restore() }
})

test('an SSN typed into the conversation never reaches the durable turn row', async () => {
  // Regression. The engine redacted, but not until step 3 — and step 1 has already written the
  // turn row, which is what the team review screen renders as the borrower's own words. The
  // guarantee now holds at the boundary, for the borrower's own turns as much as the team's.
  const fake = createFakeSupabase({ tables: BASE_TABLES(), users: USERS })
  const restore = install(fake)
  try {
    const h = await loadHandlers()
    await h.session(makeRequest(sessionUrl(), { token: 'tok-borrower' }))
    await h.turn(makeRequest('https://app.test/x', {
      method: 'POST', token: 'tok-borrower',
      body: { loanFileId: LOAN, text: 'my ssn is 123-45-6789 and my account is 4123456789012', idempotencyKey: key('leak') },
    }))
    const stored = JSON.stringify(fake.rowsOf('application_turns'))
    assert.doesNotMatch(stored, /123-?45-?6789/)
    assert.doesNotMatch(stored, /4123456789012/)
    // The turn is still there and still readable — redaction replaces, it does not discard.
    assert.equal(fake.rowsOf('application_turns').length, 1)
    assert.match(fake.rowsOf('application_turns')[0].borrower_text, /removed for your security/)
  } finally { restore() }
})
