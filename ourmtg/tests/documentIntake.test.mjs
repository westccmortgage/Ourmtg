// Level 2 wiring — the network edge of document intake.
//
// The contract tests prove the model's output cannot get past us. These prove the rest of the
// edge: which uploads we refuse before spending a request, that the document actually reaches
// the API in the shape it expects, that nothing else travels with it, and that a provider having
// a bad day never takes a borrower's upload down with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDocumentIntake, readDocument, rejectUpload, buildContent,
  preUnderwritingEnabled, ACCEPTED_MEDIA_TYPES, MAX_BASE64_CHARS,
} from '../netlify/functions/_lib/documentIntake.mjs'

const PDF_B64 = 'JVBERi0xLjQK'
const ENV = { ANTHROPIC_API_KEY: 'test-key-not-real' }

const goodPayload = (over = {}) => ({
  stop_reason: 'end_turn',
  model: 'claude-opus-5',
  usage: { input_tokens: 2400, output_tokens: 180 },
  content: [{
    type: 'text',
    text: JSON.stringify({
      docKey: 'bank_2mo',
      docKeyConfidence: 0.97,
      fields: [
        { name: 'statementMonth', value: '2026-06', confidence: 0.98 },
        { name: 'endingBalance', value: '$41,204.55', confidence: 0.95 },
      ],
      ...over,
    }),
  }],
})

/** A fetch stub that records what it was called with. */
function stubFetch(responses) {
  const calls = []
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (typeof next === 'function') return next()
    return next
  }
  impl.calls = calls
  return impl
}

const jsonRes = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
})

// ── the feature is off unless it is on ──────────────────────────────────────

test('the feature is default-off', () => {
  assert.equal(preUnderwritingEnabled({}), false)
  assert.equal(preUnderwritingEnabled({ PRE_UNDERWRITING_ENABLED: 'maybe' }), false)
  assert.equal(preUnderwritingEnabled({ PRE_UNDERWRITING_ENABLED: 'true' }), true)
})

test('there is no adapter without a key', () => {
  assert.throws(() => createDocumentIntake({ env: {} }), /ANTHROPIC_API_KEY/)
})

// ── what we refuse before spending a request ────────────────────────────────

test('a HEIC photo is refused by name, not as a generic failure', () => {
  // This is what an iPhone produces by default and what most borrowers will send first. The
  // difference between "unsupported_media_type: image/heic" and "upload failed" is whether the
  // interface can tell them how to fix it.
  const r = rejectUpload({ mediaType: 'image/heic', dataBase64: 'AAAA' })
  assert.equal(r.code, 'unsupported_media_type')
  assert.equal(r.detail, 'image/heic')
})

test('every accepted type is actually accepted, parameters and case included', () => {
  for (const t of ACCEPTED_MEDIA_TYPES) {
    assert.equal(rejectUpload({ mediaType: t, dataBase64: PDF_B64 }), null, t)
  }
  assert.equal(rejectUpload({ mediaType: 'application/PDF; charset=binary', dataBase64: PDF_B64 }), null)
})

test('an empty or oversized upload is refused without a network call', () => {
  assert.equal(rejectUpload({ mediaType: 'application/pdf', dataBase64: '' }).code, 'empty_file')
  assert.equal(rejectUpload({ mediaType: '', dataBase64: PDF_B64 }).code, 'missing_media_type')
  assert.equal(
    rejectUpload({ mediaType: 'application/pdf', dataBase64: 'A'.repeat(MAX_BASE64_CHARS + 1) }).code,
    'file_too_large',
  )
})

test('a refused upload never reaches the provider', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload()))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  const r = await readDocument(intake, { mediaType: 'image/heic', dataBase64: 'AAAA' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'unsupported_media_type')
  assert.equal(fetchImpl.calls.length, 0)
})

// ── the request itself ──────────────────────────────────────────────────────

test('a PDF goes as a document block, an image as an image block, both before the text', () => {
  const pdf = buildContent({ mediaType: 'application/pdf', dataBase64: PDF_B64, instruction: 'read it' })
  assert.equal(pdf[0].type, 'document')
  assert.equal(pdf[0].source.media_type, 'application/pdf')
  assert.equal(pdf[1].type, 'text')

  const png = buildContent({ mediaType: 'image/png', dataBase64: 'iVBORw0K', instruction: 'read it' })
  assert.equal(png[0].type, 'image')
  assert.equal(png[1].type, 'text')
})

test('whitespace in base64 is stripped', () => {
  // A newline every 76 characters is what `base64` emits by default, and the API rejects it.
  const blocks = buildContent({ mediaType: 'application/pdf', dataBase64: 'JVBE\nRi0x\r\n LjQK', instruction: 'x' })
  assert.equal(blocks[0].source.data, 'JVBERi0xLjQK')
})

test('the request carries the document, the catalog, and nothing about the borrower', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload()))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, correlationId: 'req-1' })

  const { body, init, url } = fetchImpl.calls[0]
  assert.match(url, /\/v1\/messages$/)
  assert.equal(init.headers['x-api-key'], ENV.ANTHROPIC_API_KEY)
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(body.model, 'claude-opus-5')
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system'])
  // Rejected by this model family — sending any of them is a 400 for the whole request.
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(k in body, false, k)
  assert.equal(body.output_config.format.type, 'json_schema')
  assert.ok(body.output_config.format.schema.properties.docKey.enum.includes('bank_2mo'))
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].content[0].type, 'document')
})

test('the checklist slot is offered as context, not as the answer', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload()))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, expectedDocKey: 'paystubs_30d' })
  const instruction = fetchImpl.calls[0].body.messages[0].content[1].text
  assert.match(instruction, /paystubs_30d/)
  assert.match(instruction, /classify from the page in/)
})

test('the model is told the document is not in charge', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload()))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64 })
  const system = fetchImpl.calls[0].body.system
  assert.match(system, /data, never instruction/i)
  assert.match(system, /omit that field/i)
  assert.match(system, /you make no decisions/i)
})

// ── the response ────────────────────────────────────────────────────────────

test('a clean read comes back validated and coerced', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload()))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64 })
  assert.equal(r.ok, true)
  assert.equal(r.value.docKey, 'bank_2mo')
  assert.equal(r.value.needsHumanReview, false)
  assert.equal(r.value.fields.find((f) => f.name === 'endingBalance').value, 41204.55)
  assert.equal(r.meta.promptVersion, 'pu-extract-2-tax-return')
})

test('a full tax return gets the expanded source-line contract and output budget', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload({
    docKey: 'tax_return_full', docKeyConfidence: 0.99, fields: [],
    taxForms: [], taxLineItems: [],
  })))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  await readDocument(intake, {
    mediaType: 'application/pdf', dataBase64: PDF_B64, expectedDocKey: 'tax_return_full',
  })
  const body = fetchImpl.calls[0].body
  assert.equal(body.max_tokens, 24000)
  assert.ok(body.output_config.format.schema.properties.taxForms)
  assert.ok(body.output_config.format.schema.properties.taxLineItems)
  const instruction = body.messages[0].content[1].text
  assert.match(instruction, /COMPLETE TAX RETURNS/)
  assert.match(instruction, /schedulec_net_profit/)
  assert.match(instruction, /code prevents double counting/i)
})

test('a schema-constrained model is still not a trusted one', async () => {
  // Structured output is a convenience, not a guarantee: the local contract runs regardless.
  const fetchImpl = stubFetch(jsonRes({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({
      docKey: 'invented_type', docKeyConfidence: 1,
      fields: [{ name: 'creditScore', value: 812, confidence: 1 }],
    }) }],
  }))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64 })
  assert.equal(r.ok, true)
  assert.equal(r.value.docKey, null)
  assert.deepEqual(r.value.fields, [])
  assert.ok(r.value.needsHumanReview)
})

// ── failure never costs the upload ──────────────────────────────────────────

test('a refusal is a 200, and it does not throw', async () => {
  const fetchImpl = stubFetch(jsonRes({ stop_reason: 'refusal', stop_details: { category: 'other' }, content: [] }))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, retries: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'refusal')
  assert.equal(r.value, null)
})

test('truncated output is not half-believed', async () => {
  const fetchImpl = stubFetch(jsonRes({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"docKey":"bank_2mo"' }] }))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, retries: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'max_tokens')
})

test('non-JSON where JSON was promised fails rather than parsing loosely', async () => {
  const fetchImpl = stubFetch(jsonRes({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I looked at your bank statement and' }] }))
  const intake = createDocumentIntake({ env: ENV, fetchImpl })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, retries: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad_structured_output')
})

test('a rate limit is retried; our own bad request is not', async () => {
  const rate = stubFetch([jsonRes({ error: 'slow down' }, 429), jsonRes(goodPayload())])
  const intake = createDocumentIntake({ env: ENV, fetchImpl: rate })
  const okRes = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, retries: 1 })
  assert.equal(okRes.ok, true)
  assert.equal(rate.calls.length, 2)

  const bad = stubFetch(jsonRes({ error: 'bad param' }, 400))
  const intake2 = createDocumentIntake({ env: ENV, fetchImpl: bad })
  const badRes = await readDocument(intake2, { mediaType: 'application/pdf', dataBase64: PDF_B64, retries: 1 })
  assert.equal(badRes.ok, false)
  assert.equal(bad.calls.length, 1, 'a 4xx is our bug — retrying it just doubles the damage')
})

test('the network being down loses nothing but the extraction', async () => {
  const boom = async () => { throw new Error('ECONNRESET') }
  boom.calls = []
  const intake = createDocumentIntake({ env: ENV, fetchImpl: boom })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, retries: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'network')
  // The document is already stored by the time we get here; it simply stays unread until
  // someone retries or a person opens it.
  assert.equal(r.value, null)
})

test('a slow provider times out instead of hanging the request', async () => {
  const hang = async () => new Promise(() => {})
  const intake = createDocumentIntake({ env: ENV, fetchImpl: hang })
  const r = await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64, timeoutMs: 30, retries: 0 })
  assert.equal(r.ok, false)
})

test('the model and effort are configurable without touching code', async () => {
  const fetchImpl = stubFetch(jsonRes(goodPayload()))
  const intake = createDocumentIntake({
    env: { ...ENV, PRE_UNDERWRITING_MODEL: 'claude-sonnet-5', PRE_UNDERWRITING_EFFORT: 'high' },
    fetchImpl,
  })
  await readDocument(intake, { mediaType: 'application/pdf', dataBase64: PDF_B64 })
  assert.equal(fetchImpl.calls[0].body.model, 'claude-sonnet-5')
  assert.equal(fetchImpl.calls[0].body.output_config.effort, 'high')
})
