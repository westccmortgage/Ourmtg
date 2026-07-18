// scan-provider.mjs — INERT interface for a FUTURE malware/content-scanning provider.
//
// IMPORTANT: no scanning is implemented today. This module exists only to (a) define the
// contract a real provider would satisfy and (b) make the "not scanned" state explicit at
// call sites, so nobody mistakes silence for safety. The default provider performs NO
// inspection and returns status 'unscanned'. Do NOT represent uploads as malware-scanned
// anywhere in the product until a real provider is wired and reviewed.
//
// A future provider (e.g. ClamAV via a scanning service, or a cloud AV API) would implement
// scan({ bucket, path }) → { status: 'clean'|'infected'|'error', detail? } and callers would
// quarantine/reject on anything other than 'clean'. Adding one is out of Phase 1A scope.

/** @typedef {{ status: 'clean'|'infected'|'error'|'unscanned', detail?: string }} ScanResult */

/**
 * Default no-op provider. Always reports 'unscanned' — it inspects nothing.
 * @returns {Promise<ScanResult>}
 */
export async function scan(/* { bucket, path } */) {
  return { status: 'unscanned', detail: 'No scanning provider configured (Phase 1A).' }
}

// True only when a real provider has affirmatively cleared the object. Since the default
// is 'unscanned', this is always false today — callers must not gate on it expecting a pass.
export function isClean(result) {
  return !!result && result.status === 'clean'
}
