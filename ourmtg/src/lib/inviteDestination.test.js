// The `go` parameter and the short-link token both arrive from outside — an email, a text
// message, an edited address bar. These tests hold the line that neither is ever trusted into
// a route.
import test from 'node:test'
import assert from 'node:assert/strict'
import { landingPath, inviteHref, isInviteToken, isInviteDestination } from './inviteDestination.js'

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
