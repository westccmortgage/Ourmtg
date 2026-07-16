// Phase 1C review fix (F7) — the functions-local task state machine (_lib/taskLifecycle.mjs)
// MUST stay identical to the canonical src/domain source. This test fails if they drift.
import test from 'node:test'
import assert from 'node:assert/strict'

import * as fn from '../netlify/functions/_lib/taskLifecycle.mjs'
import { TASK_TRANSITIONS, REVIEW_REQUIRED_TASK_TYPES, TEAM_ACTOR } from '../src/domain/lifecycles.js'
import { ACTION_TO_STATUS, transitionTask as srcTransition } from '../src/domain/services/taskService.js'

test('transition graph, actions, review-required set, team actors match src/domain', () => {
  assert.deepEqual(fn.TASK_TRANSITIONS, TASK_TRANSITIONS)
  assert.deepEqual(fn.ACTION_TO_STATUS, ACTION_TO_STATUS)
  assert.deepEqual(fn.REVIEW_REQUIRED_TASK_TYPES, REVIEW_REQUIRED_TASK_TYPES)
  assert.deepEqual(fn.TEAM_ACTOR, TEAM_ACTOR)
})

test('transitionTask behaves identically across a matrix of (status, action, actor)', () => {
  const statuses = Object.keys(TASK_TRANSITIONS)
  const actions = Object.keys(ACTION_TO_STATUS)
  const actors = [{ type: 'loan_officer' }, { type: 'borrower' }, { type: 'ai' }, { type: 'realtor' }, { type: 'system' }]
  for (const status of statuses) {
    for (const action of actions) {
      for (const actor of actors) {
        const task = { id: 't', task_type: 'document_request', status, evidence: [] }
        const a = fn.transitionTask({ ...task }, action, actor)
        const b = srcTransition({ ...task }, action, actor)
        assert.equal(a.ok, b.ok, `ok mismatch ${status}/${action}/${actor.type}`)
        assert.equal(a.error, b.error, `error mismatch ${status}/${action}/${actor.type}`)
        if (a.ok) assert.equal(a.task.status, b.task.status)
      }
    }
  }
})
