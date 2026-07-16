// AI boundary tests (Phase 1B §12) — AI may only PROPOSE, never act.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aiMayPerform, aiMayPropose, makeAiProposal, assertNotAiActing, AI_FORBIDDEN_ACTIONS, AI_ALLOWED_PROPOSALS,
} from '../src/domain/services/aiBoundary.js'
import { transitionTask } from '../src/domain/services/taskService.js'

test('AI may perform NO material action', () => {
  for (const a of AI_FORBIDDEN_ACTIONS) assert.equal(aiMayPerform(a), false, a)
  // approve/deny/accept/clear/complete/set-final/promise/alter-verified all forbidden
  for (const a of ['approve_loan', 'deny_loan', 'accept_document', 'clear_condition', 'complete_disclosures', 'set_final_cash_to_close', 'promise_closing', 'alter_verified_financial_field']) {
    assert.equal(aiMayPerform(a), false, a)
  }
})

test('AI may only produce the allowed proposal kinds', () => {
  for (const k of AI_ALLOWED_PROPOSALS) assert.equal(aiMayPropose(k), true, k)
  assert.equal(aiMayPropose('accept_document'), false)
  const p = makeAiProposal('suggested_task', { title: 'Maybe request bank statement' })
  assert.equal(p.ok, true)
  assert.equal(p.proposal.requires_human_approval, true)
  assert.equal(p.proposal.applied, false)
  assert.equal(makeAiProposal('clear_condition').error, 'ai_action_forbidden')
})

test('assertNotAiActing blocks an AI actor in any executor pipeline', () => {
  assert.equal(assertNotAiActing('ai', 'accept_document').ok, false)
  assert.equal(assertNotAiActing('loan_officer', 'accept_document').ok, true)
})

test('AI cannot complete a task requiring human review (integration with task service)', () => {
  const r = transitionTask({ id: 't', task_type: 'condition', status: 'team_review', evidence: [] }, 'accept', { type: 'ai' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'ai_forbidden')
})
