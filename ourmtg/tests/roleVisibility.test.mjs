// Role & visibility tests (Phase 1B §13).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canViewBorrowerTasks, canViewInternalNotes, canViewFinancialDocuments, canViewCashToClose,
  realtorVisibleFields, escrowTitleVisibleFields, loanRoleGrantsPlatformAdmin,
} from '../src/domain/visibility.js'
import { isSettingsAdmin } from '../netlify/functions/_lib/portal.mjs'

test('borrower sees own tasks (with grant), not another borrower’s file', () => {
  assert.equal(canViewBorrowerTasks('borrower', { hasGrant: true }), true)
  assert.equal(canViewBorrowerTasks('borrower', { hasGrant: false }), false) // no grant → cannot see the file
})

test('borrower cannot see internal notes; team can', () => {
  assert.equal(canViewInternalNotes('borrower'), false)
  assert.equal(canViewInternalNotes('coborrower'), false)
  assert.equal(canViewInternalNotes('processor'), true)
  assert.equal(canViewInternalNotes('loan_officer'), true)
})

test('borrower cannot see internal asset/income calculations (financial docs gated by grant)', () => {
  assert.equal(canViewFinancialDocuments('borrower', { hasGrant: true }), true)
  assert.equal(canViewFinancialDocuments('realtor', { hasGrant: true }), false)
})

test('co-borrower sees allowed shared items with a grant', () => {
  assert.equal(canViewBorrowerTasks('coborrower', { hasGrant: true }), true)
  assert.equal(canViewCashToClose('coborrower', { hasGrant: true }), true)
})

test('realtor: stage/milestone/preapproval only; never income/assets/docs/cash', () => {
  const f = realtorVisibleFields()
  assert.equal(f.stage, true)
  assert.equal(f.majorMilestone, true)
  assert.equal(f.preapprovalBand, true)
  assert.equal(f.income, false)
  assert.equal(f.assets, false)
  assert.equal(f.documents, false)
  assert.equal(f.internalNotes, false)
  assert.equal(f.cashAccounts, false)
  assert.equal(f.cashToClose, false)
  assert.equal(canViewCashToClose('realtor', { hasGrant: true }), false)
  assert.equal(canViewBorrowerTasks('realtor', { hasGrant: true }), false)
})

test('escrow/title: only permitted transaction milestones, no borrower financial docs', () => {
  const f = escrowTitleVisibleFields()
  assert.equal(f.permittedTransactionMilestones, true)
  assert.equal(f.borrowerFinancialDocuments, false)
  assert.equal(f.income, false)
  assert.equal(canViewFinancialDocuments('escrow', { hasGrant: true }), false)
  assert.equal(canViewFinancialDocuments('title', { hasGrant: true }), false)
})

test('loan team: reviews docs/tasks within scope (team membership grants access)', () => {
  assert.equal(canViewBorrowerTasks('processor', { isTeam: true }), true)
  assert.equal(canViewFinancialDocuments('loan_officer', { isTeam: true }), true)
})

test('admin authority is separate from loan ownership', () => {
  assert.equal(loanRoleGrantsPlatformAdmin(), false)
  // owning a loan does not put you on the platform-admin allowlist
  assert.equal(isSettingsAdmin('owner@example.com', 'admin@ourmtg.com'), false)
  assert.equal(isSettingsAdmin('admin@ourmtg.com', 'admin@ourmtg.com'), true)
})
