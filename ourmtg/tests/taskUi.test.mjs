import test from 'node:test'
import assert from 'node:assert/strict'
import { teamActionsForTask, actionNeedsBorrowerReason, borrowerPreparationActions } from '../src/lib/taskUi.js'

test('more-info and reopen require borrower-visible reasons', () => {
  assert.equal(actionNeedsBorrowerReason('reject'), true)
  assert.equal(actionNeedsBorrowerReason('requestMoreInfo'), true)
  assert.equal(actionNeedsBorrowerReason('reopen'), true)
  assert.equal(actionNeedsBorrowerReason('accept'), false)
})

test('team UI renders only lifecycle-valid actions', () => {
  assert.deepEqual(teamActionsForTask('team_review').map((a) => a.action), ['accept', 'reject', 'requestMoreInfo'])
  assert.deepEqual(teamActionsForTask('submitted').map((a) => a.action), ['sendToTeamReview', 'requestMoreInfo'])
  assert.deepEqual(teamActionsForTask('accepted').map((a) => a.action), ['complete', 'reopen'])
  assert.deepEqual(teamActionsForTask('completed').map((a) => a.action), ['reopen'])
  assert.deepEqual(teamActionsForTask('in_progress'), [])
})

test('borrower document flow prepares assigned/viewed/correction tasks before finalize', () => {
  assert.deepEqual(borrowerPreparationActions('assigned'), ['view', 'begin'])
  assert.deepEqual(borrowerPreparationActions('viewed'), ['begin'])
  assert.deepEqual(borrowerPreparationActions('rejected'), ['begin'])
  assert.deepEqual(borrowerPreparationActions('more_information_needed'), ['begin'])
  assert.deepEqual(borrowerPreparationActions('reopened'), ['begin'])
  assert.deepEqual(borrowerPreparationActions('in_progress'), [])
  assert.equal(borrowerPreparationActions('submitted'), null)
})
