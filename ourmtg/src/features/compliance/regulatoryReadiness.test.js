import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REGULATORY_CATALOG_VERSION, REGULATORY_SOURCES, normalizeProgram,
  requiredRegulatoryForms, regulatoryReadiness,
} from './regulatoryReadiness.js'

const ALL_CONTROLS = Object.freeze({
  internalMfaEnforced: true,
  documentScannerConfigured: true,
  retentionPolicyApproved: true,
  controlledTextsReviewed: true,
  fieldCoverageApproved: true,
  programCatalogApproved: true,
  tridTriggerImplemented: true,
  regBNotificationsImplemented: true,
  privacyProgramApproved: true,
})

test('the regulatory catalog is versioned and every source is directly attributable', () => {
  assert.match(REGULATORY_CATALOG_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/)
  for (const source of Object.values(REGULATORY_SOURCES)) {
    assert.ok(source.id && source.authority && source.title && source.sourceRevision)
    assert.match(source.url, /^https:\/\//)
  }
})

test('program forms are explicit and unknown applicability never becomes not-required', () => {
  assert.equal(normalizeProgram('FHA'), 'fha')
  const fha = requiredRegulatoryForms({ loanType: 'FHA' })
  assert.deepEqual(fha.forms.map((f) => f.sourceId), ['urla-1003-2021', 'hud-92900-a'])

  const conventional = requiredRegulatoryForms({
    loanType: 'Conventional', applicationDate: '2026-08-08', gseDelivery: null,
  })
  assert.equal(conventional.forms.find((f) => f.sourceId === 'scif-1103-2023').applicability, 'undetermined')
})

test('readiness blocks on every unverified control and can never imply a credit decision', () => {
  const blocked = regulatoryReadiness({ loanType: 'VA', controls: {} })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.blockers.length, 9)
  assert.ok(blocked.notMeaning.some((value) => /approval or denial/i.test(value)))

  const ready = regulatoryReadiness({ loanType: 'USDA', controls: ALL_CONTROLS })
  assert.equal(ready.status, 'ready_for_controlled_pilot')
  assert.deepEqual(ready.forms.map((f) => f.sourceId), ['urla-1003-2021', 'rd-3555-origination'])
})

test('an unknown loan program is a blocker, not a conventional default', () => {
  const result = regulatoryReadiness({ loanType: '', controls: ALL_CONTROLS })
  assert.equal(result.status, 'blocked')
  assert.equal(result.program, null)
  assert.ok(result.blockers.some((b) => b.code === 'program_unknown'))
})
