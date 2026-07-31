// The `go` parameter and the short-link token both arrive from outside — an email, a text
// message, an edited address bar. These tests hold the line that neither is ever trusted into
// a route.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  landingPath, inviteHref, isInviteToken, isInviteDestination, resolveMyApplication,
} from './inviteDestination.js'

const FILE = '8f3a1c2e-1111-2222-3333-444455556666'
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

test('known destinations route where they say', () => {
  assert.equal(landingPath('application', FILE), `/application/assistant/${FILE}`)
  assert.equal(landingPath('documents', FILE), `/portal/documents/${FILE}`)
})

test('anything unrecognized falls back to the portal', () => {
  for (const go of ['', null, undefined, 'portal', 'admin', 'APPLICATION', 'application ']) {
    assert.equal(landingPath(go, FILE), '/portal', `expected fallback for ${JSON.stringify(go)}`)
  }
})

test('a hostile go value cannot escape into a path', () => {
  // The failure this guards against: interpolating `go` into a route and letting a link decide
  // where in the app — or off it — the borrower lands.
  for (const go of ['../portal/file/other', '//evil.example.com', 'application/../../x', 'https://evil.example.com']) {
    assert.equal(landingPath(go, FILE), '/portal')
    assert.ok(!isInviteDestination(go))
  }
})

test('no loan file id means no specific destination', () => {
  // A redemption that did not tell us which file it belongs to has nowhere specific to go, and
  // must not produce "/application/assistant/undefined".
  assert.equal(landingPath('application', null), '/portal')
  assert.equal(landingPath('application', undefined), '/portal')
  assert.equal(landingPath('application', ''), '/portal')
})

test('inviteHref carries a known destination through sign-in and drops the rest', () => {
  assert.equal(inviteHref(TOKEN, 'application'), `/invite?token=${TOKEN}&go=application`)
  assert.equal(inviteHref(TOKEN, 'documents'), `/invite?token=${TOKEN}&go=documents`)
  assert.equal(inviteHref(TOKEN, 'nonsense'), `/invite?token=${TOKEN}`)
  assert.equal(inviteHref(TOKEN), `/invite?token=${TOKEN}`)
})

test('inviteHref encodes the token rather than pasting it into a query string', () => {
  assert.equal(inviteHref('a b&go=documents', 'application'), '/invite?token=a%20b%26go%3Ddocuments&go=application')
})

test('short-link tokens must be exactly what we mint', () => {
  assert.ok(isInviteToken(TOKEN))
  assert.ok(isInviteToken(TOKEN.toUpperCase()))
  // The common real-world failure is a text message clipping the tail.
  assert.ok(!isInviteToken(TOKEN.slice(0, 31)))
  assert.ok(!isInviteToken(`${TOKEN}0`))
  for (const bad of ['', null, undefined, 'not-a-token', `${TOKEN.slice(0, 31)}z`, `../${TOKEN}`]) {
    assert.ok(!isInviteToken(bad), `expected rejection for ${JSON.stringify(bad)}`)
  }
})

// ── "my application", resolved from portal_access grants ─────────────────────
const grant = (visibility, loan_file_id) => ({ visibility, loan_file_id })

test('one borrower grant goes straight in', () => {
  assert.deepEqual(resolveMyApplication([grant('borrower', FILE)]), { kind: 'one', loanFileId: FILE })
  assert.deepEqual(resolveMyApplication([grant('coborrower', FILE)]), { kind: 'one', loanFileId: FILE })
})

test('a loan officer has no application of their own', () => {
  // Internal users hold grants too. Sending them into someone else's interview would be wrong,
  // and the endpoint would refuse them anyway — they are not borrower or coborrower on it.
  const r = resolveMyApplication([grant('owner', FILE), grant('realtor', 'other'), grant('escrow', 'x')])
  assert.deepEqual(r, { kind: 'none' })
})

test('several borrower files ask instead of guessing', () => {
  const r = resolveMyApplication([grant('borrower', FILE), grant('coborrower', 'second-file')])
  assert.equal(r.kind, 'choose')
  assert.equal(r.files.length, 2)
})

test('partner roles never count toward the choice', () => {
  const r = resolveMyApplication([grant('borrower', FILE), grant('realtor', 'r1'), grant('title', 't1')])
  assert.deepEqual(r, { kind: 'one', loanFileId: FILE })
})

test('junk grants cannot produce a route', () => {
  // A grant row missing its file id must not become /application/assistant/undefined.
  for (const g of [[], null, undefined, [null], [grant('borrower', null)], [grant('borrower', undefined)], [{}]]) {
    assert.deepEqual(resolveMyApplication(g), { kind: 'none' }, `expected none for ${JSON.stringify(g)}`)
  }
})
