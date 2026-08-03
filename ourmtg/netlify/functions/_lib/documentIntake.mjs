// Autopilot Pre-Underwriting, Level 2 — server-side wiring for document intake.
//
// The pure parts live in src/features/pre-underwriting/ and are imported unchanged, exactly as
// the conversational 1003 does. This module owns only what must be server-side: the API key,
// the network call, the timeout and retry policy, and the size/format limits that stop a
// 40-megabyte scan from becoming a 500.
//
// SECURITY
//   • The provider key is read from process.env only. There is no VITE_ equivalent.
//   • The document itself is sent — that is the point — but nothing else is: no borrower record,
//     no other documents, no tokens, no account context. The model sees one file and a catalog.
//   • The response is untrusted and goes through validateExtractionResponse before anything is
//     believed, whatever the structured-output schema said.

import { serverFlag } from './featureFlags.mjs'
import { logEvent } from './safelog.mjs'
import { callWithGuard, ProviderError } from '../../../src/features/conversational-1003/providers/providerInterface.js'
import {
  validateExtractionResponse, extractionApiSchema,
} from '../../../src/features/pre-underwriting/extractionContract.js'
import {
  EXTRACTION_SYSTEM_PROMPT, EXTRACTION_PROMPT_VERSION, buildExtractionInstruction,
} from '../../../src/features/pre-underwriting/extractionPrompt.js'

export const FLAG = 'PRE_UNDERWRITING_ENABLED'

/** Default-off, like every other AI surface here. Missing/malformed/false ⇒ the feature 404s. */
export function preUnderwritingEnabled(env = process.env) {
  return serverFlag(FLAG, env)
}

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-opus-5'
// Reading a document is careful work in a way that parsing one borrower sentence is not: a
// smudged digit, a period that spans a month boundary, a total that has to be reconciled against
// its lines. Worth more thought than the interview turn gets.
const DEFAULT_EFFORT = 'medium'
const DEFAULT_MAX_TOKENS = 8192
// Scans go through OCR before the model has read a word. The 20s the interview uses would time
// out on an ordinary twelve-page bank statement.
const DEFAULT_TIMEOUT_MS = 90_000

// The API accepts PDFs as documents and these four as images. Everything else — HEIC above all,
// which is what an iPhone produces by default — has to be converted before it gets here, and
// saying so precisely is the difference between a fixable message and "upload failed".
const PDF = 'application/pdf'
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const ACCEPTED_MEDIA_TYPES = Object.freeze([PDF, ...IMAGE_TYPES])

// The request limit is 32MB including base64 expansion; stop well short so a large file fails
// here, cheaply and with an explanation, rather than as an opaque provider error.
export const MAX_BASE64_CHARS = 26_000_000

/**
 * Why an upload cannot be read, before any network call.
 * @returns {{code: string, detail?: string}|null}
 */
export function rejectUpload({ mediaType, dataBase64 }) {
  const type = String(mediaType || '').toLowerCase().split(';')[0].trim()
  if (!type) return { code: 'missing_media_type' }
  if (type !== PDF && !IMAGE_TYPES.has(type)) {
    return { code: 'unsupported_media_type', detail: type }
  }
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return { code: 'empty_file' }
  if (dataBase64.length > MAX_BASE64_CHARS) return { code: 'file_too_large' }
  return null
}

/**
 * Build the content blocks for one upload.
 *
 * The document or image block goes BEFORE the text block. That ordering is what the API expects
 * and it also reads correctly: here is the page, now here is what to do with it.
 */
export function buildContent({ mediaType, dataBase64, instruction }) {
  const type = String(mediaType).toLowerCase().split(';')[0].trim()
  const source = {
    type: 'base64',
    media_type: type,
    // Base64 with newlines in it is a common artifact of shelling out to `base64` and the API
    // rejects it. Strip once, here, rather than in every caller.
    data: dataBase64.replace(/\s+/g, ''),
  }
  return [
    type === PDF ? { type: 'document', source } : { type: 'image', source },
    { type: 'text', text: instruction },
  ]
}

/**
 * Live adapter over the Anthropic Messages API using fetch — no vendor SDK, no new dependency,
 * the same shape as the conversational 1003 adapter so there is one way to call this API here.
 *
 * Deliberately NOT sent: temperature / top_p / top_k (rejected by this model family), and no
 * `thinking: disabled`. Depth is controlled with `effort`.
 */
export function createDocumentIntake({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')
  const model = env.PRE_UNDERWRITING_MODEL || DEFAULT_MODEL
  const effort = env.PRE_UNDERWRITING_EFFORT || DEFAULT_EFFORT
  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'

  async function extractOnce({ mediaType, dataBase64, expectedDocKey, pageCount, correlationId }) {
    const body = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: buildContent({
          mediaType,
          dataBase64,
          instruction: buildExtractionInstruction({ expectedDocKey, pageCount }),
        }),
      }],
      output_config: {
        effort,
        format: { type: 'json_schema', schema: extractionApiSchema() },
      },
    }

    let res
    try {
      res = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new ProviderError('network failure', { code: 'network', retryable: true, cause: e })
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500
      let detail = ''
      try { detail = (await res.text()).slice(0, 400) } catch { /* body already consumed */ }
      logEvent('pu.intake.http_error', {
        severity: 'error', requestId: correlationId, status: res.status, detail,
      })
      throw new ProviderError(`provider http ${res.status}`, { code: `http_${res.status}`, retryable })
    }

    const payload = await res.json().catch(() => null)
    if (!payload) throw new ProviderError('unparsable provider response', { code: 'bad_json', retryable: true })

    // A safety-classifier decline arrives as a successful 200 with an empty body, never as an
    // exception. On this path it usually means the upload was not a mortgage document at all.
    if (payload.stop_reason === 'refusal') {
      logEvent('pu.intake.refusal', {
        severity: 'warn', requestId: correlationId, category: payload.stop_details?.category || null,
      })
      throw new ProviderError('provider declined', { code: 'refusal', retryable: false })
    }
    if (payload.stop_reason === 'max_tokens') {
      throw new ProviderError('provider output truncated', { code: 'max_tokens', retryable: false })
    }

    const text = (payload.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('')

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProviderError('provider returned non-JSON', { code: 'bad_structured_output', retryable: true })
    }
    return { parsed, usage: payload.usage || null, modelUsed: payload.model || model }
  }

  return {
    name: 'anthropic',
    modelVersion: model,
    extractOnce,
  }
}

/**
 * Read one uploaded document. NEVER throws.
 *
 * A provider failure produces `{ok: false}` and the document stays in the file, unclassified,
 * waiting for a person — the same posture the interview takes when the model is slow. Nothing a
 * borrower already sent is ever lost because an extraction failed.
 *
 * @returns {{ok: boolean, value: object|null, error: object|null, meta: object}}
 */
export async function readDocument(intake, {
  mediaType, dataBase64, expectedDocKey = null, pageCount = null,
  correlationId, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1,
}) {
  const started = Date.now()
  const refusal = rejectUpload({ mediaType, dataBase64 })
  if (refusal) {
    logEvent('pu.intake.rejected', { severity: 'info', requestId: correlationId, code: refusal.code })
    return {
      ok: false,
      value: null,
      error: { code: refusal.code, message: 'this file cannot be read', detail: refusal.detail || null },
      meta: { provider: intake?.name || null, model: intake?.modelVersion || null, ms: 0 },
    }
  }

  const call = await callWithGuard(
    () => intake.extractOnce({ mediaType, dataBase64, expectedDocKey, pageCount, correlationId }),
    { timeoutMs, retries },
  )

  const meta = {
    provider: intake.name,
    model: intake.modelVersion,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    attempts: call.attempts,
    ms: Date.now() - started,
  }

  if (!call.ok) {
    logEvent('pu.intake.failed', {
      severity: 'warn', requestId: correlationId, errorCode: call.error?.code, ...meta,
    })
    return { ok: false, value: null, error: call.error, meta }
  }

  const validated = validateExtractionResponse(call.value.parsed, { expectedDocKey })

  logEvent('pu.intake.read', {
    severity: 'info',
    requestId: correlationId,
    ...meta,
    // What was read, never what it said. Field values are borrower data and do not belong in a
    // log line; counts and confidences are what tell us whether this is working.
    docKey: validated.value.docKey,
    docKeyConfidence: validated.value.docKeyConfidence,
    fields: validated.value.fields.length,
    rejectedFields: validated.rejected.length,
    minFieldConfidence: validated.value.minFieldConfidence,
    needsHumanReview: validated.value.needsHumanReview,
    reviewReasons: validated.value.reviewReasons,
    inputTokens: call.value.usage?.input_tokens ?? null,
    outputTokens: call.value.usage?.output_tokens ?? null,
  })

  return {
    ok: true,
    value: validated.value,
    error: null,
    meta: { ...meta, modelUsed: call.value.modelUsed, rejected: validated.rejected, errors: validated.errors },
  }
}

export { EXTRACTION_PROMPT_VERSION }
