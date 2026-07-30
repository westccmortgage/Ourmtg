// Conversational 1003 — server-side wiring: feature flag, provider selection, live adapter.
//
// The pure engine lives in src/features/conversational-1003/ and is imported unchanged here,
// so the borrower interview logic is identical on the client, the server, and in tests. This
// module owns only the things that must be server-side: the API key, the network call, the
// timeout/retry policy, and the refusal to run a mock in front of a real borrower.
//
// SECURITY
//   • The provider key is read from process.env only. There is no VITE_ equivalent and there
//     must never be one — see .env.example.
//   • Prompts carry the borrower's own words and the allowed field paths. They never carry
//     secrets, tokens, SSNs, or account numbers (turnContract redacts before we get here).
//   • The model's output is untrusted: every response goes through validateTurnResponse.

import { serverFlag } from './featureFlags.mjs'
import { logEvent } from './safelog.mjs'
import {
  callWithGuard, ProviderError, assertProvider,
} from '../../../src/features/conversational-1003/providers/providerInterface.js'
import { createMockProvider, MOCK_PROVIDER_NAME } from '../../../src/features/conversational-1003/providers/mockProvider.js'
import { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION, buildTurnInstruction } from '../../../src/features/conversational-1003/providers/systemPrompt.js'
import { apiJsonSchema, TURN_RESPONSE_SCHEMA } from '../../../src/features/conversational-1003/turnContract.js'

export const FLAG = 'CONVERSATIONAL_1003_ENABLED'

/** Default-off (§4). Missing/malformed/false ⇒ the whole feature 404s. */
export function conversational1003Enabled(env = process.env) {
  return serverFlag(FLAG, env)
}

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-opus-5'
const DEFAULT_EFFORT = 'low' // structured extraction: shallow is correct and much cheaper
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Live adapter over the Anthropic Messages API using fetch (the repo has no vendor SDK and
 * this adds no dependency). Structured output is requested via output_config.format; the
 * response is still validated locally because a schema-constrained model is not a trusted one.
 *
 * Deliberately NOT sent: temperature / top_p / top_k (rejected by this model family), and no
 * `thinking: disabled` — thinking is on by default and disabling it is both effort-capped and
 * associated with tool-call/tag leakage. Depth is controlled with `effort` instead.
 */
export function createAnthropicProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured')
  const model = env.CONVERSATIONAL_1003_MODEL || DEFAULT_MODEL
  const effort = env.CONVERSATIONAL_1003_EFFORT || DEFAULT_EFFORT
  const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'

  async function messages({ system, userText, schema, maxTokens = DEFAULT_MAX_TOKENS, correlationId }) {
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
      output_config: {
        effort,
        ...(schema ? { format: { type: 'json_schema', schema } } : {}),
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
      // 429 and 5xx are worth another attempt; 4xx is our bug and must not be retried.
      const retryable = res.status === 429 || res.status >= 500
      let detail = ''
      try { detail = (await res.text()).slice(0, 400) } catch { /* body already consumed */ }
      logEvent('c1003.provider.http_error', {
        severity: 'error', requestId: correlationId, status: res.status, detail,
      })
      throw new ProviderError(`provider http ${res.status}`, {
        code: `http_${res.status}`, retryable,
      })
    }

    const payload = await res.json().catch(() => null)
    if (!payload) throw new ProviderError('unparsable provider response', { code: 'bad_json', retryable: true })

    // A safety-classifier decline is a successful HTTP 200 with an empty/partial body — never
    // an exception. Treat it as "no interpretation available" and fall back deterministically.
    if (payload.stop_reason === 'refusal') {
      logEvent('c1003.provider.refusal', {
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
    return { text, usage: payload.usage || null, modelUsed: payload.model || model }
  }

  return assertProvider({
    name: 'anthropic',
    modelVersion: model,

    async interpretTurn({ text, context, correlationId }) {
      const instruction = buildTurnInstruction({ context })
      const out = await messages({
        system: `${SYSTEM_PROMPT}\n\n${instruction}`,
        userText: text,
        schema: apiJsonSchema(TURN_RESPONSE_SCHEMA),
        correlationId,
      })
      try {
        return JSON.parse(out.text)
      } catch {
        throw new ProviderError('provider returned non-JSON', { code: 'bad_structured_output', retryable: true })
      }
    },

    async explainQuestion({ question, locale, correlationId }) {
      const out = await messages({
        system: `${SYSTEM_PROMPT}\n\nExplain the active question in plain language for a borrower. Two sentences maximum. Reply in locale "${locale}". Do not restate any legally controlling wording; do not ask for the answer.`,
        userText: `Question: ${question?.prompt}\nWhy it is asked: ${question?.why}`,
        maxTokens: 512,
        correlationId,
      })
      return { text: out.text.trim() }
    },

    async renderNextQuestion({ question, locale, correlationId }) {
      // The planner already chose the field; the model may only re-word it. Locked official
      // text is never re-worded — the caller checks this too, belt and braces.
      if (question?.officialTextLocked) return { text: question.prompt }
      const out = await messages({
        system: `${SYSTEM_PROMPT}\n\nRe-word the given question so a first-time borrower understands it. Keep the exact same meaning and ask for the same single fact. One sentence. Reply in locale "${locale}".`,
        userText: `Question: ${question?.prompt}\nData type expected: ${question?.dataType}`,
        maxTokens: 256,
        correlationId,
      })
      return { text: out.text.trim() || question?.prompt || '' }
    },

    async summarizeReview({ report, locale, correlationId }) {
      const out = await messages({
        system: `${SYSTEM_PROMPT}\n\nSummarize what remains for the borrower to finish. Never say the application is complete, approved, or pre-approved. Two sentences maximum. Reply in locale "${locale}".`,
        userText: `Open items: ${report?.openFields?.length ?? 0}. Conflicts: ${report?.conflicts?.length ?? 0}. Percent: ${report?.percent ?? 0}.`,
        maxTokens: 256,
        correlationId,
      })
      return { text: out.text.trim() }
    },
  })
}

/**
 * Choose a provider from the environment.
 *
 * CONVERSATIONAL_1003_PROVIDER = 'anthropic' | 'mock'
 *
 * The mock is refused whenever a real borrower could be on the other end: it is permitted only
 * when CONVERSATIONAL_1003_ALLOW_MOCK is explicitly on (tests, local dev, CI). §29 forbids
 * hardcoded fake AI responses in the production path, and this is where that is enforced.
 */
export function selectProvider({ env = process.env, fetchImpl } = {}) {
  const requested = (env.CONVERSATIONAL_1003_PROVIDER || '').trim().toLowerCase()

  if (requested === MOCK_PROVIDER_NAME) {
    if (!serverFlag('CONVERSATIONAL_1003_ALLOW_MOCK', env)) {
      return { ok: false, error: 'mock_provider_not_permitted' }
    }
    return { ok: true, provider: createMockProvider() }
  }
  if (requested === 'anthropic' || requested === '') {
    if (!env.ANTHROPIC_API_KEY) return { ok: false, error: 'provider_not_configured' }
    try {
      return { ok: true, provider: createAnthropicProvider({ env, fetchImpl }) }
    } catch (e) {
      return { ok: false, error: 'provider_not_configured', detail: e.message }
    }
  }
  return { ok: false, error: 'unknown_provider' }
}

/**
 * Interpret one borrower turn. NEVER throws — a provider failure returns
 * { ok:false, interpretation:null } and the caller proceeds deterministically, which is what
 * makes §24's "an answer never disappears because the model was slow" true.
 */
export async function interpretWithProvider(provider, { text, context, correlationId, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 }) {
  const started = Date.now()
  const result = await callWithGuard(
    () => provider.interpretTurn({ text, context, correlationId }),
    { timeoutMs, retries },
  )
  logEvent('c1003.interpret', {
    severity: result.ok ? 'info' : 'warn',
    requestId: correlationId,
    provider: provider.name,
    model: provider.modelVersion,
    promptVersion: SYSTEM_PROMPT_VERSION,
    ok: result.ok,
    attempts: result.attempts,
    ms: Date.now() - started,
    ...(result.ok ? {} : { errorCode: result.error?.code }),
  })
  return {
    ok: result.ok,
    raw: result.value ?? null,
    error: result.error,
    meta: {
      provider: provider.name,
      model: provider.modelVersion,
      promptVersion: SYSTEM_PROMPT_VERSION,
      attempts: result.attempts,
      ms: result.ms,
    },
  }
}

export { SYSTEM_PROMPT_VERSION }
