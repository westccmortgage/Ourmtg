// Authorization contract tests (Phase 1A Blockers A + §6). Pure helpers only — no network.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canSeeFinancials, isInternal, parseAdminEmails, isSettingsAdmin, storageDocPath,
} from '../netlify/functions/_lib/portal.mjs'
import { isValidDocKey } from '../netlify/functions/_lib/checklist.mjs'

// ── Site-settings admin authorization: the 10 required cases (Blocker A) ──────────────
// Identity always derives from the verified JWT email (auth.user.email); the handler never
// reads a body-supplied email. isSettingsAdmin encodes the decision given that trusted email.
const ADMINS = ' Admin@OurMTG.com , owner@wcc.com '

test('A1 no JWT → denied (empty identity → false; handler returns 401 before reaching here)', () => {
  assert.equal(isSettingsAdmin('', ADMINS), false)
  assert.equal(isSettingsAdmin(null, ADMINS), false)
})
test('A2 malformed JWT → denied (authUser yields no email → false)', () => {
  assert.equal(isSettingsAdmin(undefined, ADMINS), false)
})
test('A3 authenticated borrower → denied', () => {
  assert.equal(isSettingsAdmin('borrower@example.com', ADMINS), false)
})
test('A4 authenticated realtor → denied', () => {
  assert.equal(isSettingsAdmin('realtor@example.com', ADMINS), false)
})
test('A5 loan owner NOT in admin list → denied (no ownership escalation path)', () => {
  assert.equal(isSettingsAdmin('some-owner@example.com', ADMINS), false)
})
test('A6 team member NOT in admin list → denied', () => {
  assert.equal(isSettingsAdmin('processor@example.com', ADMINS), false)
})
test('A7 configured admin → allowed', () => {
  assert.equal(isSettingsAdmin('admin@ourmtg.com', ADMINS), true)
  assert.equal(isSettingsAdmin('owner@wcc.com', ADMINS), true)
})
test('A8 missing OURMTG_ADMIN_EMAILS → fail closed (no one)', () => {
  assert.equal(isSettingsAdmin('admin@ourmtg.com', ''), false)
  assert.equal(isSettingsAdmin('admin@ourmtg.com', undefined), false)
})
test('A9 case + whitespace normalization', () => {
  assert.equal(isSettingsAdmin('  ADMIN@OURMTG.COM ', ADMINS), true)
  assert.deepEqual(parseAdminEmails(ADMINS), ['admin@ourmtg.com', 'owner@wcc.com'])
})
test('A10 decision depends solely on the (JWT) email arg — a spoofed body email cannot alter it', () => {
  // The handler passes auth.user.email only; there is no code path that consults a body email.
  // Same trusted email → same verdict regardless of any attacker-controlled payload.
  assert.equal(isSettingsAdmin('borrower@example.com', ADMINS), false)
  assert.equal(isSettingsAdmin('admin@ourmtg.com', ADMINS), true)
})

// ── Financial-data + internal gating ─────────────────────────────────────────────────
test('canSeeFinancials: owner/borrower/coborrower only', () => {
  for (const v of ['owner', 'borrower', 'coborrower']) assert.equal(canSeeFinancials(v), true, v)
  for (const v of ['realtor', 'escrow', 'title', '', undefined, null]) assert.equal(canSeeFinancials(v), false, String(v))
})

test('isInternal: owner/team internal; portal grantees + null are not', () => {
  assert.equal(isInternal({ role: 'owner' }), true)
  assert.equal(isInternal({ role: 'team' }), true)
  assert.equal(isInternal({ role: 'portal', visibility: 'borrower' }), false)
  assert.equal(isInternal(null), false)
})

// ── Server-controlled storage path + doc-key allowlist ───────────────────────────────
test('storageDocPath: always rooted at <owner>/<file>/ and sanitizes traversal', () => {
  assert.equal(storageDocPath('o1', 'f1', 'paystubs_30d', 'r'), 'o1/f1/paystubs_30d-r')
  const evil = storageDocPath('o1', 'f1', '../../etc/passwd', 'r')
  assert.ok(evil.startsWith('o1/f1/') && !evil.includes('..') && !evil.includes('/etc/'), evil)
  assert.equal(storageDocPath('o', 'f', '', 'r'), 'o/f/doc-r')
})

test('isValidDocKey: real slots vs arbitrary; type/purpose shaping', () => {
  const conv = { loanType: 'Conventional', purpose: 'Purchase' }
  assert.equal(isValidDocKey(conv, 'paystubs_30d'), true)
  assert.equal(isValidDocKey(conv, 'purchase_contract'), true)
  assert.equal(isValidDocKey(conv, 'ssn_card'), false)
  assert.equal(isValidDocKey({ loanType: 'VA', purpose: 'Purchase' }, 'coe'), true)
  assert.equal(isValidDocKey({ loanType: 'Non-QM', purpose: 'Purchase' }, 'paystubs_30d'), false)
})
