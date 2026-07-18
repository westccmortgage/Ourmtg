// Phase 1C EXT-10 — server-side feature flags are FAIL-CLOSED. Missing / malformed / anything
// other than 'true' | '1' => disabled. VITE_FF_* is presentation-only and never consulted here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { serverFlag, taskPilotEnabled, loanTeamTaskPilotEnabled } from '../netlify/functions/_lib/featureFlags.mjs'

test('serverFlag: only "true" or "1" enable; everything else is OFF', () => {
  assert.equal(serverFlag('X', { X: 'true' }), true)
  assert.equal(serverFlag('X', { X: '1' }), true)
  assert.equal(serverFlag('X', { X: 'false' }), false)
  assert.equal(serverFlag('X', { X: 'TRUE' }), false) // strict casing
  assert.equal(serverFlag('X', { X: 'yes' }), false)
  assert.equal(serverFlag('X', { X: '' }), false)
  assert.equal(serverFlag('X', {}), false)            // missing → off
  assert.equal(serverFlag('X', undefined), false)     // no env → off
})

test('taskPilotEnabled reads FF_TASK_PILOT, fail-closed', () => {
  assert.equal(taskPilotEnabled({ FF_TASK_PILOT: 'true' }), true)
  assert.equal(taskPilotEnabled({ FF_TASK_PILOT: '0' }), false)
  assert.equal(taskPilotEnabled({}), false)
})

test('loanTeamTaskPilotEnabled reads FF_LOAN_TEAM_TASK_PILOT, fail-closed', () => {
  assert.equal(loanTeamTaskPilotEnabled({ FF_LOAN_TEAM_TASK_PILOT: '1' }), true)
  assert.equal(loanTeamTaskPilotEnabled({ FF_LOAN_TEAM_TASK_PILOT: 'nope' }), false)
  assert.equal(loanTeamTaskPilotEnabled({}), false)
})

test('VITE_ presentation flags do NOT enable the server gate', () => {
  assert.equal(taskPilotEnabled({ VITE_FF_TASK_PILOT: 'true' }), false)
  assert.equal(loanTeamTaskPilotEnabled({ VITE_FF_LOAN_TEAM_TASK_PILOT: 'true' }), false)
})
