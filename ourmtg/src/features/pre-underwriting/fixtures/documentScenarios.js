// Eleven synthetic documents, in the shape a reader actually returns them.
//
// ── Why these are fixtures and not test literals ────────────────────────────
// Every one of these is a real thing that happens to a real borrower in a week of normal
// operation, and each one is a different answer to "what do we say next?". Keeping them in one
// named list means a change to the follow-up voice, the completeness rules, or the extraction
// contract is checked against all eleven at once, by name, instead of against whichever two a
// particular test file happened to cover.
//
// ── The data ────────────────────────────────────────────────────────────────
// ALL OF IT IS INVENTED. No real person, no real account, no real institution. Names are
// obviously fictional, the banks do not exist, and no field carries anything that would be
// sensitive even if it were real: no Social Security numbers, no account numbers, no addresses.
// Nothing in this file may ever be replaced with a redacted real document — a redaction that
// misses one line is a data breach committed by a test fixture.
//
// ── The shape ───────────────────────────────────────────────────────────────
// `raw` is what a model returns, untrusted, before validation. The tests run it through the REAL
// `validateExtractionResponse`, so these fixtures exercise the contract rather than bypassing
// it — a scenario that only works because the test hand-built a validated value would prove
// nothing about what happens in production.

// Relative to a fixed "today" so the fixtures do not rot: a statement that is current when
// written becomes stale six months later and the test starts failing for the calendar's
// reasons rather than the code's.
export const AS_OF = Date.parse('2026-09-15T00:00:00Z')

const ym = (back) => {
  const d = new Date(AS_OF)
  d.setUTCMonth(d.getUTCMonth() - back)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const day = (back) => new Date(AS_OF - back * 86_400_000).toISOString().slice(0, 10)

const f = (name, value, confidence = 0.95) => ({ name, value, confidence })

const statement = (month, extra = []) => [
  f('accountHolder', 'Marcus Vandermeer'),
  f('institutionName', 'Northharbor Savings Bank'),
  f('statementMonth', month),
  f('statementEnd', `${month}-28`),
  ...extra,
]

export const BORROWER_NAME = 'Marcus Vandermeer'

/**
 * The eleven.
 *
 * `expect` is what the deterministic layer must conclude — asserted, not described. If a rule
 * changes so that one of these stops producing its gap, the scenario fails by name and the
 * failure says which borrower situation just stopped working.
 */
export const SCENARIOS = Object.freeze([
  {
    key: 'clean_complete',
    title: 'Everything arrived, and it is all there',
    why: 'The baseline. If this ever produces a gap, the system is asking for things that are already on file — which is how a borrower learns to ignore us.',
    docKey: 'bank_2mo',
    raw: {
      docKey: 'bank_2mo',
      docKeyConfidence: 0.97,
      legible: true,
      fields: statement(ym(0), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    },
    others: [{
      docKey: 'bank_2mo',
      docKeyConfidence: 0.97,
      legible: true,
      fields: statement(ym(1), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    }],
    expect: { complete: true, gapCodes: [] },
  },

  {
    key: 'missing_pages',
    title: 'Pages 1–5 and 7 of a seven-page statement',
    why: 'The single most common upload defect. The ask has to name page 6, or the borrower re-scans the whole statement and we have gained nothing.',
    docKey: 'bank_2mo',
    raw: {
      docKey: 'bank_2mo',
      docKeyConfidence: 0.97,
      legible: true,
      fields: statement(ym(0), [f('pagesSeen', '1-5, 7'), f('pagesTotal', 7)]),
    },
    others: [{
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(1), [f('pagesSeen', '1-7'), f('pagesTotal', 7)]),
    }],
    expect: {
      complete: false,
      gapCodes: ['missing_pages'],
      messageMatches: [/pages 1–5 and 7/, /Page 6 is still missing/],
    },
  },

  {
    key: 'missing_months',
    title: 'One statement where two months are required',
    why: 'A borrower who sends the newest statement has done half the job and believes they have done all of it.',
    docKey: 'bank_2mo',
    raw: {
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(0), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    },
    expect: { complete: false, gapCodes: ['missing_months'] },
  },

  {
    key: 'gap_in_months',
    title: 'A hole between two statement months',
    why: 'Naming the months is the difference between one upload and re-checking a year of statements.',
    docKey: 'bank_12mo',
    raw: {
      docKey: 'bank_12mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(0), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    },
    others: Array.from({ length: 11 }, (_, i) => (i === 3 ? null : {
      docKey: 'bank_12mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(i + 1), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    })).filter(Boolean),
    expect: { complete: false, gapCodes: ['gap_in_months'] },
  },

  {
    key: 'missing_side',
    title: 'The front of a driver’s licence and no back',
    why: 'Phone cameras photograph one side. The ask has to say which side is missing.',
    docKey: 'id_photo',
    raw: {
      docKey: 'id_photo', docKeyConfidence: 0.98, legible: true,
      fields: [
        f('fullName', BORROWER_NAME),
        f('side', 'front'),
        f('expirationDate', '2031-04-30'),
      ],
    },
    expect: { complete: false, gapCodes: ['missing_side'], messageMatches: [/back/i] },
  },

  {
    key: 'expired_id',
    title: 'An ID that expired last month',
    why: 'An expired ID looks exactly like a valid one to everyone except a date comparison.',
    docKey: 'id_photo',
    raw: {
      docKey: 'id_photo', docKeyConfidence: 0.98, legible: true,
      fields: [
        f('fullName', BORROWER_NAME), f('side', 'front'),
        f('expirationDate', day(40)),
      ],
    },
    others: [{
      docKey: 'id_photo', docKeyConfidence: 0.98, legible: true,
      fields: [f('fullName', BORROWER_NAME), f('side', 'back'), f('expirationDate', day(40))],
    }],
    expect: { complete: false, gapCodes: ['expired'] },
  },

  {
    key: 'unreadable_scan',
    title: 'A photograph nobody can read',
    why: 'A document that cannot be read has satisfied nothing. Counting it as present is the exact failure this layer exists to prevent.',
    docKey: 'paystubs_30d',
    raw: {
      docKey: 'paystubs_30d', docKeyConfidence: 0.71,
      legible: false,
      fields: [f('employeeName', BORROWER_NAME, 0.4)],
      notes: 'Image is heavily blurred; no line items resolvable.',
    },
    expect: {
      complete: false,
      gapCodes: ['illegible'],
      messageMatches: [/clearer photo or scan/i],
      // No cause invented. We do not know whether it was the camera, the paper, or the light.
      messageForbids: [/your phone/i, /bad lighting/i, /you did/i],
    },
  },

  {
    key: 'duplicate_upload',
    title: 'The same statement sent twice',
    why: 'People re-send when they are not sure the first one arrived. It is not an error, and treating it as one would leave the file permanently short of an item nothing could ever close.',
    docKey: 'bank_2mo',
    raw: {
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(0), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    },
    others: [
      {
        docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
        fields: statement(ym(0), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
      },
      {
        docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
        fields: statement(ym(1), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
      },
    ],
    expect: {
      // Informational: the borrower sent everything, so the document IS complete.
      complete: true,
      gapCodes: ['duplicate'],
      messageMatches: [/more than once/, /you do not need to do anything/i],
    },
  },

  {
    key: 'wrong_owner',
    title: 'A statement in a name that shares nothing with the borrower’s',
    why: 'Joint accounts, maiden names and nicknames all look like this to a string comparison, so the ask is a question and never an accusation.',
    docKey: 'bank_2mo',
    raw: {
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: [
        f('accountHolder', 'Priya Okonkwo-Silva'),
        f('institutionName', 'Northharbor Savings Bank'),
        f('statementMonth', ym(0)), f('statementEnd', `${ym(0)}-28`),
        f('pagesSeen', '1-4'), f('pagesTotal', 4),
      ],
    },
    others: [{
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(1), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    }],
    expect: {
      complete: false,
      gapCodes: ['ownership_unclear'],
      messageMatches: [/If that is you/, /maiden name/],
      messageForbids: [/not yours/i, /fraud/i, /someone else's account/i],
    },
  },

  {
    key: 'misfiled_type',
    title: 'A W-2 uploaded into the pay-stub request',
    why: 'The borrower has still uploaded a W-2. Filing it as a pay stub is how it gets lost, and asking them to "re-upload your pay stub" when they already sent something real is how they stop trusting the list.',
    docKey: 'paystubs_30d',
    raw: {
      docKey: 'w2_2yr', docKeyConfidence: 0.96, legible: true,
      fields: [f('taxYear', 2025), f('employeeName', BORROWER_NAME), f('wagesTipsOther', 94800)],
    },
    expectedDocKey: 'paystubs_30d',
    expect: { docKeyMismatch: true, resolvedDocKey: 'w2_2yr' },
  },

  {
    key: 'stale_documents',
    title: 'Two statements that are both nine months old',
    why: 'Complete, contiguous, legible — and useless. Every other rule passes, so staleness has to be its own check.',
    docKey: 'bank_2mo',
    raw: {
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(9), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    },
    others: [{
      docKey: 'bank_2mo', docKeyConfidence: 0.97, legible: true,
      fields: statement(ym(10), [f('pagesSeen', '1-4'), f('pagesTotal', 4)]),
    }],
    expect: { complete: false, gapCodes: ['stale'] },
  },

  {
    key: 'unclassifiable',
    title: 'Something the reader cannot name',
    why: 'An invented type files itself against a checklist slot that does not exist and satisfies nothing. The contract has to refuse it and keep what the model said so a person can look.',
    docKey: null,
    raw: {
      docKey: 'utility_bill_summary',
      docKeyConfidence: 0.55,
      legible: true,
      fields: [f('accountHolder', BORROWER_NAME, 0.6)],
    },
    expect: { validationErrors: ['unknown_doc_key'], resolvedDocKey: null },
  },
])

export const SCENARIO_KEYS = Object.freeze(SCENARIOS.map((s) => s.key))

/** Look one up by name, so a test reads as the situation it is about. */
export const scenario = (key) => {
  const hit = SCENARIOS.find((s) => s.key === key)
  if (!hit) throw new Error(`no such document scenario: ${key}`)
  return hit
}
