// Malware-scanning boundary. A scanner is server-side and receives only the private storage
// locator, never a public download URL. The configured service is responsible for reading that
// object with its own narrowly scoped credentials. Missing configuration stays visibly
// `unscanned`; pre-underwriting treats that as a blocker by default.

import { serverFlag } from './featureFlags.mjs'

/** @typedef {{ status: 'clean'|'infected'|'error'|'unscanned', detail?: string }} ScanResult */

/**
 * Default no-op provider. Always reports 'unscanned' — it inspects nothing.
 * @returns {Promise<ScanResult>}
 */
export function documentScanRequired(env = process.env) {
  return serverFlag('DOCUMENT_UPLOAD_REQUIRE_CLEAN_SCAN', env)
}

export function preUnderwritingScanRequired(env = process.env) {
  // Reading financial documents with a model is the higher-risk boundary. It is fail-closed
  // unless an operator makes the narrower, explicit local-development exception.
  return env?.PRE_UNDERWRITING_REQUIRE_CLEAN_SCAN !== 'false'
}

function normalizeResult(value) {
  const status = String(value?.status || '').toLowerCase()
  if (!['clean', 'infected', 'error', 'unscanned'].includes(status)) {
    return { status: 'error', detail: 'Scanner returned an invalid status.' }
  }
  return { status, ...(value?.detail ? { detail: String(value.detail).slice(0, 300) } : {}) }
}

/** Build the configured provider. `mock` is refused unless independently allowed. */
export function createScanProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const kind = String(env?.OURMTG_DOCUMENT_SCAN_PROVIDER || '').trim().toLowerCase()
  if (!kind) {
    return {
      name: 'none',
      scan: async () => ({ status: 'unscanned', detail: 'No document scanner is configured.' }),
    }
  }
  if (kind === 'mock') {
    if (!serverFlag('OURMTG_ALLOW_MOCK_SCAN', env)) throw new Error('Mock document scanner is not allowed')
    return {
      name: 'mock',
      scan: async () => normalizeResult({ status: env.OURMTG_MOCK_SCAN_STATUS || 'clean' }),
    }
  }
  if (kind !== 'http') throw new Error('Unknown document scanner provider')

  const url = String(env?.OURMTG_DOCUMENT_SCAN_URL || '').trim()
  const token = String(env?.OURMTG_DOCUMENT_SCAN_TOKEN || '').trim()
  if (!url || !token) throw new Error('Document scanner URL/token are not configured')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('Document scanner URL must use HTTPS')

  return {
    name: 'http',
    async scan({ bucket, path, correlationId = null }) {
      let response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
          },
          body: JSON.stringify({ bucket, path }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch {
        return { status: 'error', detail: 'Scanner request failed.' }
      }
      if (!response.ok) return { status: 'error', detail: `Scanner returned HTTP ${response.status}.` }
      try { return normalizeResult(await response.json()) }
      catch { return { status: 'error', detail: 'Scanner returned unreadable output.' } }
    },
  }
}

/** Backwards-compatible call for old imports; still makes the unscanned state explicit. */
export async function scan(input, options) {
  return createScanProvider(options).scan(input)
}

// True only when a real provider has affirmatively cleared the object. Since the default
// is 'unscanned', this is always false today — callers must not gate on it expecting a pass.
export function isClean(result) {
  return !!result && result.status === 'clean'
}

export function scanDecision(result, { required = false } = {}) {
  if (isClean(result)) return { ok: true }
  if (result?.status === 'infected') {
    return { ok: false, status: 422, code: 'malware_detected', error: 'The uploaded file was rejected by the security scan.' }
  }
  if (result?.status === 'error') {
    return { ok: false, status: 503, code: 'scan_failed', error: 'The document security scan could not be completed. Please try again.' }
  }
  if (required) {
    return { ok: false, status: 503, code: 'scan_not_configured', error: 'Document security scanning is not configured.' }
  }
  return { ok: true, warning: 'unscanned' }
}
