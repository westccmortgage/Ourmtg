// Phase 0 contract tests — pure, zero new dependencies (Node built-in node:test + node:assert).
// These verify the domain scaffolding stays consistent and never alters production behavior:
//   1. every feature flag defaults OFF;
//   2. the re-exported stage vocabulary still matches the app's single source (src/lib/pipeline.js);
//   3. the NEW vocabularies do not duplicate any existing app enum;
//   4. the contract manifest references only real, frozen vocab arrays.
// Run: from ourmtg/  ->  node --test src/domain/

import test from 'node:test'
import assert from 'node:assert/strict'

import { FLAGS, flag } from './flags.js'
import {
  STAGE_STEPS,
  EVENT_TYPES,
  TASK_STATUS,
  VENDOR_TYPE,
  VENDOR_STATUS,
  DELIVERY_CHANNEL,
  DELIVERY_STATUS,
  CTC_DIRECTION,
  PIPELINE_STAGES,
} from './vocab.js'
import { CONTRACTS } from './contracts.js'
import { STAGE_STEPS as PIPELINE_SOURCE } from '../lib/pipeline.js'

test('every feature flag defaults to false (Phase 0 dark)', () => {
  for (const [name, value] of Object.entries(FLAGS)) {
    assert.equal(value, false, `flag "${name}" must default false`)
    assert.equal(flag(name), false, `flag("${name}") must resolve false with no env override`)
  }
})

test('re-exported stages match the single source in src/lib/pipeline.js', () => {
  assert.deepEqual(STAGE_STEPS, PIPELINE_SOURCE)
  assert.deepEqual(PIPELINE_STAGES, PIPELINE_SOURCE)
  // Guard the known 7-stage order so a silent reorder is caught.
  assert.deepEqual(STAGE_STEPS, [
    'lead', 'preapproval', 'processing', 'underwriting', 'conditional', 'ctc', 'funded',
  ])
})

test('new vocab does not duplicate existing app enums (no forked enums)', () => {
  // These are the vocabularies the app already owns (DB CHECK constraints / pipeline.js).
  const EXISTING_DOC_STATUS = ['requested', 'uploaded', 'accepted', 'rejected']
  const EXISTING_CONDITION_STATUS = ['open', 'submitted', 'cleared']
  const EXISTING_STRATEGY_STATUS = ['draft', 'approved', 'hidden']
  const EXISTING_VISIBILITY = ['borrower', 'coborrower', 'realtor', 'escrow', 'title']

  // The new event types must not simply re-list a stage as its own event name.
  for (const s of STAGE_STEPS) {
    assert.ok(!EVENT_TYPES.includes(s), `EVENT_TYPES must not redefine stage "${s}"`)
  }
  // New status vocabularies must be distinct arrays from the existing ones (not the same set).
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
  assert.ok(!sameSet(TASK_STATUS, EXISTING_DOC_STATUS), 'TASK_STATUS must not equal doc status')
  assert.ok(!sameSet(TASK_STATUS, EXISTING_CONDITION_STATUS), 'TASK_STATUS must not equal condition status')
  assert.ok(!sameSet(VENDOR_STATUS, EXISTING_STRATEGY_STATUS), 'VENDOR_STATUS must not equal strategy status')
  assert.ok(!sameSet(VENDOR_TYPE, EXISTING_VISIBILITY), 'VENDOR_TYPE must not equal visibility roles')
})

test('all new vocab arrays are frozen and non-empty', () => {
  for (const arr of [EVENT_TYPES, TASK_STATUS, VENDOR_TYPE, VENDOR_STATUS, DELIVERY_CHANNEL, DELIVERY_STATUS, CTC_DIRECTION]) {
    assert.ok(Array.isArray(arr) && arr.length > 0)
    assert.ok(Object.isFrozen(arr), 'vocab arrays must be frozen (Object.freeze)')
  }
})

test('contract manifest references real, non-empty vocab arrays and carries tenant', () => {
  for (const [name, def] of Object.entries(CONTRACTS)) {
    assert.equal(def.tenant, 'owner_user_id', `${name} must be tenant-scoped by owner_user_id`)
    assert.ok(typeof def.table === 'string' && def.table.length > 0, `${name} needs a table`)
    for (const [field, arr] of Object.entries(def.vocab || {})) {
      assert.ok(Array.isArray(arr) && arr.length > 0, `${name}.${field} must map to a real vocab array`)
    }
  }
})
