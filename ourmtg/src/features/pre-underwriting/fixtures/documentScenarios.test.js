// Every named scenario, driven through the real contract and the real rules.
//
// Each case starts as a raw model response — untrusted — and goes through
// validateExtractionResponse → toPart → assessCompleteness → buildFileTasks → composeFollowUp,
// which is the same path a borrower's upload takes in production. Nothing is hand-built past
// the model boundary, because a scenario that only passes on a pre-validated value proves
// nothing about what the borrower actually gets told.

import test from 'node:test'
import assert from 'node:assert/strict'
import { SCENARIOS, SCENARIO_KEYS, AS_OF, BORROWER_NAME, scenario } from './documentScenarios.js'
import { validateExtractionResponse, toPart } from '../extractionContract.js'
import { assessCompleteness } from '../completeness.js'
import { buildFileTasks, borrowerView } from '../fileTasks.js'
import { composeFollowUp } from '../followUp.js'

const opts = { asOf: AS_OF, borrowerName: BORROWER_NAME }

/** Raw model response → the parts completeness reads, through the real contract. */
function partsFor(s) {
  const raws = [s.raw, ...(s.others || [])]
  return raws
    .map((raw) => validateExtractionResponse(raw, { expectedDocKey: s.expectedDocKey || s.docKey }))
    .map((v) => toPart(v))
    .filter(Boolean)
}

// The document behaviors the product is required to handle. The scenarios exist to cover these,
// so THIS is what the suite asserts — a count would break the first time a real situation was
// added, which is exactly when the fixtures are doing their job.
const REQUIRED_BEHAVIORS = Object.freeze({
  'classifies the type': ['clean_complete', 'misfiled_type', 'unclassifiable'],
  'reads the institution': ['clean_complete', 'missing_pages'],
  'reads the period': ['missing_months', 'gap_in_months', 'stale_documents'],
  'counts pages and names the missing ones': ['missing_pages'],
  'notices a missing side': ['missing_side'],
  'notices missing months': ['missing_months', 'gap_in_months'],
  'notices an unreadable scan': ['unreadable_scan'],
  'notices an expiration': ['expired_id'],
  'notices a duplicate': ['duplicate_upload'],
  'questions ownership without asserting it': ['wrong_owner'],
  'notices staleness': ['stale_documents'],
  'refuses to invent a type': ['unclassifiable'],
})

test('every required document behavior is covered by a named scenario', () => {
  const known = new Set(SCENARIO_KEYS)
  for (const [behavior, keys] of Object.entries(REQUIRED_BEHAVIORS)) {
    for (const key of keys) {
      assert.ok(known.has(key), `"${behavior}" names a scenario that does not exist: ${key}`)
    }
  }
  assert.equal(new Set(SCENARIO_KEYS).size, SCENARIOS.length, 'two scenarios share a name')
  for (const s of SCENARIOS) {
    assert.ok(s.title && s.why, `${s.key} must say what it is and why it matters`)
  }
  // Every scenario earns its place: one that covers no listed behavior is dead weight.
  const covered = new Set(Object.values(REQUIRED_BEHAVIORS).flat())
  for (const key of SCENARIO_KEYS) assert.ok(covered.has(key), `${key} covers no required behavior`)
})

test('no fixture carries anything that would be sensitive if it were real', () => {
  // A redaction that misses one line is a data breach committed by a test fixture, so the rule
  // is that these are invented rather than redacted — and this is the check that says so.
  const text = JSON.stringify(SCENARIOS)
  assert.ok(!/\b\d{3}-\d{2}-\d{4}\b/.test(text), 'a Social Security number shape appeared')
  assert.ok(!/\b(?:\d[ -]?){13,19}\b/.test(text), 'a card/account number shape appeared')
  assert.ok(!/@[a-z0-9-]+\.(com|net|org)/i.test(text), 'an email address appeared')
  for (const real of ['Chase', 'Wells Fargo', 'Bank of America', 'Citibank', 'Equifax', 'Experian']) {
    assert.ok(!text.includes(real), `${real} is a real institution — fixtures use invented ones`)
  }
})

for (const s of SCENARIOS) {
  test(`scenario: ${s.key} — ${s.title}`, () => {
    const validated = validateExtractionResponse(s.raw, { expectedDocKey: s.expectedDocKey || s.docKey })

    if (s.expect.validationErrors) {
      for (const err of s.expect.validationErrors) {
        assert.ok(validated.errors.includes(err), `expected validation error ${err}, got ${validated.errors.join(',')}`)
      }
    }
    if ('resolvedDocKey' in s.expect) {
      assert.equal(validated.value.docKey, s.expect.resolvedDocKey)
    }
    if ('docKeyMismatch' in s.expect) {
      assert.equal(validated.value.docKeyMismatch, s.expect.docKeyMismatch)
    }
    if (!('complete' in s.expect)) return

    const parts = partsFor(s)
    const result = assessCompleteness(s.docKey, parts, opts)
    assert.equal(result.complete, s.expect.complete, JSON.stringify(result.gaps))

    const codes = result.gaps.map((g) => g.code)
    for (const code of s.expect.gapCodes) {
      assert.ok(codes.includes(code), `expected gap ${code}, got [${codes.join(', ')}]`)
    }
    if (s.expect.gapCodes.length === 0) assert.deepEqual(codes, [])

    const messages = result.gaps.map((g) => g.message).join('\n')
    for (const m of s.expect.messageMatches || []) assert.match(messages, m)
    for (const m of s.expect.messageForbids || []) {
      assert.ok(!m.test(messages), `message said something it must not: ${m}\n${messages}`)
    }
  })
}

test('every scenario a borrower must act on produces a borrower-safe ask', () => {
  // The whole point of the deterministic layer: these sentences go straight to a borrower.
  for (const s of SCENARIOS) {
    if (!('complete' in s.expect) || s.expect.complete) continue
    const { tasks } = buildFileTasks({
      checklist: [{ docKey: s.docKey }],
      byType: { [s.docKey]: partsFor(s) },
      credit: { authorized: true },
      asOf: AS_OF, borrowerName: BORROWER_NAME,
    })
    const mine = borrowerView(tasks)
    assert.ok(mine.length > 0, `${s.key} produced nothing for the borrower to do`)
    // Only what a borrower READS. `docKey` is a routing field the screen uses to open the right
    // upload; asserting against the serialized object would flag the key name itself, which is
    // a test that fails on its own plumbing rather than on anything a borrower could see.
    const said = mine.map((t) => [t.title, ...(t.requests || [])].join(' ')).join('\n')
    for (const forbidden of [/approv/i, /qualif/i, /denied/i, /\brisk\b/i, /min_records/, /history_gap/, /doc_?key/i, /bank_2mo|paystubs_30d|id_photo/]) {
      assert.ok(!forbidden.test(said), `${s.key} leaked ${forbidden}: ${said.slice(0, 200)}`)
    }
  }
})

test('the follow-up for a missing page names the page, end to end', () => {
  const s = scenario('missing_pages')
  const { tasks } = buildFileTasks({
    checklist: [{ docKey: s.docKey }],
    byType: { [s.docKey]: partsFor(s) },
    credit: { authorized: true },
    asOf: AS_OF,
  })
  const out = composeFollowUp({ tasks, justRead: 'bank statement' })
  assert.equal(out.send, true)
  assert.match(out.body, /Page 6 is still missing/)
  assert.match(out.body, /Northharbor Savings Bank statement/)
})

test('a duplicate never becomes something the borrower has to fix', () => {
  const s = scenario('duplicate_upload')
  const { tasks, operational } = buildFileTasks({
    checklist: [{ docKey: s.docKey }],
    byType: { [s.docKey]: partsFor(s) },
    credit: { authorized: true },
    asOf: AS_OF,
  })
  assert.equal(borrowerView(tasks).length, 0, 'a re-send must not read as an outstanding item')
  assert.equal(operational.borrowerOutstanding, 0)
})

test('an ownership question is asked as a question', () => {
  const s = scenario('wrong_owner')
  const result = assessCompleteness(s.docKey, partsFor(s), opts)
  const gap = result.gaps.find((g) => g.code === 'ownership_unclear')
  assert.equal(gap.needsConfirmation, true, 'uncertainty must not be recorded as fact')
})

test('a shared surname is never treated as a different person', () => {
  // The false positive that would matter: telling someone their own statement is not theirs.
  for (const name of ['M. Vandermeer', 'Marcus J Vandermeer', 'Vandermeer, Marcus', 'Marcus Vandermeer-Osei', 'MARCUS VANDERMEER']) {
    const parts = [{
      accountHolder: name, institutionName: 'Northharbor Savings Bank',
      statementMonth: '2026-09', statementEnd: '2026-09-28', pagesSeen: [1, 2], pagesTotal: 2, legible: true,
    }, {
      accountHolder: name, institutionName: 'Northharbor Savings Bank',
      statementMonth: '2026-08', statementEnd: '2026-08-28', pagesSeen: [1, 2], pagesTotal: 2, legible: true,
    }]
    const codes = assessCompleteness('bank_2mo', parts, opts).gaps.map((g) => g.code)
    assert.ok(!codes.includes('ownership_unclear'), `"${name}" was wrongly flagged as someone else`)
  }
})

test('with no borrower name on file, ownership is not guessed at', () => {
  const s = scenario('wrong_owner')
  const codes = assessCompleteness(s.docKey, partsFor(s), { asOf: AS_OF }).gaps.map((g) => g.code)
  assert.ok(!codes.includes('ownership_unclear'))
})
