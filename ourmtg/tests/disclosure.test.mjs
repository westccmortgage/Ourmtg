// Disclosure state-model tests (Phase 1B §9) — states must NOT be collapsed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  transitionDisclosure, isSent, isDelivered, isOpened, isCompleted, TEAM_STATUS_LABEL,
  BORROWER_DISCLOSURE_EXPLANATION,
} from '../src/domain/services/disclosureService.js'

test('sent, delivered, opened, completed are distinct states', () => {
  assert.notEqual(TEAM_STATUS_LABEL.sent, TEAM_STATUS_LABEL.delivered)
  assert.notEqual(TEAM_STATUS_LABEL.delivered, TEAM_STATUS_LABEL.opened)
  assert.notEqual(TEAM_STATUS_LABEL.opened, TEAM_STATUS_LABEL.completed)
  // predicate distinctness: sent is not delivered is not opened is not completed
  assert.ok(isSent('sent') && !isDelivered('sent') && !isOpened('sent') && !isCompleted('sent'))
  assert.ok(isDelivered('delivered') && !isOpened('delivered') && !isCompleted('delivered'))
  assert.ok(isOpened('opened') && !isCompleted('opened'))
  assert.ok(isCompleted('completed'))
})

test('valid lifecycle progression', () => {
  let pkg = { status: 'prepared' }
  for (const to of ['sent', 'provider_accepted', 'delivered', 'opened', 'viewed', 'partially_signed', 'completed']) {
    const r = transitionDisclosure(pkg, to, { at: 't' })
    assert.equal(r.ok, true, `prepared→…→${to}`)
    pkg = r.package
  }
  assert.equal(pkg.status, 'completed')
})

test('cannot skip states (e.g. prepared → completed) — no collapsing', () => {
  assert.equal(transitionDisclosure({ status: 'prepared' }, 'completed').error, 'invalid_transition')
  assert.equal(transitionDisclosure({ status: 'sent' }, 'opened').error, 'invalid_transition') // must be delivered first
})

test('bounce and resend path', () => {
  const bounced = transitionDisclosure({ status: 'sent' }, 'bounced')
  assert.equal(bounced.ok, true)
  const resend = transitionDisclosure(bounced.package, 'resend_required')
  assert.equal(resend.ok, true)
  assert.equal(resend.package.resend_required, true)
  assert.equal(transitionDisclosure(resend.package, 'sent').ok, true)
})

test('borrower explanation is non-obligating and present', () => {
  assert.match(BORROWER_DISCLOSURE_EXPLANATION, /does not obligate you/i)
})
