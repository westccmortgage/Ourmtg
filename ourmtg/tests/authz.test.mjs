// Authorization & access-control contract tests (Phase 1A #5).
// Pure helpers only — no network, no Supabase. Run: npm test
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canSeeFinancials, isInternal, parseAdminEmails, isSettingsAdmin, storageDocPath,
} from '../netlify/functions/_lib/portal.mjs'
import { isValidDocKey } from '../netlify/functions/_lib/checklist.mjs'

test('canSeeFinancials: owner/borrower/coborrower only; realtor/escrow/title excluded', () => {
  for (const v of ['owner', 'borrower', 'coborrower']) assert.equal(canSeeFinancials(v), true, v)
  for (const v of ['realtor', 'escrow', 'title', '', undefined, null]) assert.equal(canSeeFinancials(v), false, String(v))
})

test('isInternal: owner and team are internal; portal grantees and null are not', () => {
  assert.equal(isInternal({ role: 'owner', visibility: 'owner' }), true)
  assert.equal(isInternal({ role: 'team', visibility: 'owner' }), true)
  assert.equal(isInternal({ role: 'portal', visibility: 'borrower' }), false)
  assert.equal(isInternal({ role: 'portal', visibility: 'realtor' }), false)
  assert.equal(isInternal(null), false)
  assert.equal(isInternal(undefined), false)
})

test('parseAdminEmails: trims, lowercases, drops empties', () => {
  assert.deepEqual(parseAdminEmails(' A@x.com , b@Y.com ,,'), ['a@x.com', 'b@y.com'])
  assert.deepEqual(parseAdminEmails(''), [])
  assert.deepEqual(parseAdminEmails(undefined), [])
})

test('isSettingsAdmin: allowlist only, case-insensitive, fail-closed when empty', () => {
  const list = 'admin@ourmtg.com, Owner@Wcc.com'
  assert.equal(isSettingsAdmin('admin@ourmtg.com', list), true)
  assert.equal(isSettingsAdmin('ADMIN@OURMTG.COM', list), true) // case-insensitive
  assert.equal(isSettingsAdmin('owner@wcc.com', list), true)
  assert.equal(isSettingsAdmin('borrower@example.com', list), false) // not on the list
  assert.equal(isSettingsAdmin('', list), false)
  // Empty/unset allowlist authorizes NO ONE (the removed "owns a file" escalation).
  assert.equal(isSettingsAdmin('admin@ourmtg.com', ''), false)
  assert.equal(isSettingsAdmin('admin@ourmtg.com', undefined), false)
})

test('storageDocPath: always rooted at <owner>/<file>/ and sanitizes traversal', () => {
  assert.equal(storageDocPath('owner1', 'file1', 'paystubs_30d', 'abcd'), 'owner1/file1/paystubs_30d-abcd')
  // Path-traversal attempt in docKey is stripped; still rooted under owner1/file1/.
  const evil = storageDocPath('owner1', 'file1', '../../etc/passwd', 'r')
  assert.ok(evil.startsWith('owner1/file1/'), evil)
  assert.ok(!evil.includes('..'), evil)
  assert.ok(!evil.includes('/etc/'), evil)
  // Empty docKey falls back to a safe placeholder, never an empty segment.
  assert.equal(storageDocPath('o', 'f', '', 'r'), 'o/f/doc-r')
})

test('isValidDocKey: allowlists real checklist slots, rejects arbitrary keys', () => {
  const conv = { loanType: 'Conventional', purpose: 'Purchase' }
  assert.equal(isValidDocKey(conv, 'paystubs_30d'), true)
  assert.equal(isValidDocKey(conv, 'id_photo'), true)
  assert.equal(isValidDocKey(conv, 'purchase_contract'), true) // purchase add-on
  assert.equal(isValidDocKey(conv, 'ssn_card'), false)         // not a slot
  assert.equal(isValidDocKey(conv, '../secret'), false)

  // Purpose/type shape the checklist.
  assert.equal(isValidDocKey({ loanType: 'Conventional', purpose: 'Rate-Term Refi' }, 'mortgage_statement'), true)
  assert.equal(isValidDocKey({ loanType: 'VA', purpose: 'Purchase' }, 'coe'), true)
  // Non-QM is a bank-statement program: wage-earner docs are dropped.
  assert.equal(isValidDocKey({ loanType: 'Non-QM', purpose: 'Purchase' }, 'bank_12mo'), true)
  assert.equal(isValidDocKey({ loanType: 'Non-QM', purpose: 'Purchase' }, 'paystubs_30d'), false)
})
