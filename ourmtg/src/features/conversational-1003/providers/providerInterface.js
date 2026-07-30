// Conversational 1003 — AI provider abstraction (§21).
//
// The borrower application is NOT bound to one model vendor. Everything the rest of the system
// needs from a language model is expressed by these four calls; swapping vendors means writing
// one adapter, not touching the engine.
//
// Hard rules every adapter must honor:
//   • server-side only — an adapter is never imported into the browser bundle
//   • no secrets in prompts, no API key in any VITE_ variable
//   • structured output validated by turnContract.js before anything is believed
//   • a timeout and a bounded retry; on exhaustion, the caller falls back deterministically
//   • provider name + model version recorded per turn, without exposing credentials

/**
 * @typedef {object} ApplicationAIProvider
 * @property {string} name                     stable provider id, e.g. 'anthropic' | 'mock'
 * @property {string} modelVersion             recorded with every interpreted turn
 * @property {(args:InterpretArgs)=>Promise<object>} interpretTurn
 * @property {(args:ExplainArgs)=>Promise<{text:string}>} explainQuestion
 * @property {(args:RenderArgs)=>Promise<{text:string}>} renderNextQuestion
 * @property {(args:SummarizeArgs)=>Promise<{text:string}>} summarizeReview
 */

export const PROVIDER_CAPABILITIES = Object.freeze({
  interpretTurn: 'interpretTurn',
  explainQuestion: 'explainQuestion',
  renderNextQuestion: 'renderNextQuestion',
  summarizeReview: 'summarizeReview',
})

export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', retryable = false, cause = null } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.retryable = retryable
    this.cause = cause
  }
}

/** Every adapter must implement these; a partial object is a programming error, not a runtime one. */
export function assertProvider(p) {
  const missing = Object.values(PROVIDER_CAPABILITIES).filter((m) => typeof p?.[m] !== 'function')
  if (missing.length) throw new Error(`provider missing: ${missing.join(', ')}`)
  if (!p.name || !p.modelVersion) throw new Error('provider must declare name and modelVersion')
  return p
}

/**
 * Run a provider call with a timeout and bounded retries. Retries ONLY on retryable errors and
 * never more than `retries` times, so a flapping provider cannot amplify into a request storm.
 * Returns { ok, value, error, attempts, ms }.
 */
export async function callWithGuard(fn, {
  timeoutMs = 12_000, retries = 1, onAttempt = null, sleep = defaultSleep, now = () => Date.now(),
} = {}) {
  const started = now()
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (onAttempt) onAttempt(attempt)
    try {
      const value = await withTimeout(fn(attempt), timeoutMs)
      return { ok: true, value, error: null, attempts: attempt + 1, ms: now() - started }
    } catch (e) {
      lastError = e
      const retryable = e instanceof ProviderError ? e.retryable : e?.name === 'TimeoutError'
      if (!retryable || attempt === retries) break
      await sleep(150 * (attempt + 1))
    }
  }
  return {
    ok: false,
    value: null,
    error: { code: lastError?.code || 'provider_error', message: lastError?.message || 'provider failed' },
    attempts: retries + 1,
    ms: now() - started,
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error('provider timeout')
      err.name = 'TimeoutError'
      reject(err)
    }, ms)
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))
