// Phase 1C Functional Completion — browser-side pending-operation registry.
// A logical mutation receives one idempotency key before the first request and keeps it
// through double-click, timeout and refresh recovery.

const PREFIX = 'ourmtg.pending.v1:'

function storageOrNull(storage) {
  if (storage) return storage
  try { return globalThis.localStorage || null } catch { return null }
}

function operationId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID() } catch { /* fallback */ }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function stableJson(value) {
  const seen = new WeakSet()
  const normalize = (v) => {
    if (v === undefined) return null
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return v.map(normalize)
    const out = {}
    for (const key of Object.keys(v).sort()) out[key] = normalize(v[key])
    return out
  }
  return JSON.stringify(normalize(value))
}

export function readPendingOperation(scope, storage) {
  const s = storageOrNull(storage)
  if (!s || !scope) return null
  try {
    const parsed = JSON.parse(s.getItem(PREFIX + scope) || 'null')
    return parsed?.idempotencyKey && parsed?.materialKey ? parsed : null
  } catch { return null }
}

export function getOrCreatePendingOperation(scope, material, storage, options = {}) {
  const s = storageOrNull(storage)
  const existing = readPendingOperation(scope, s)
  const materialKey = stableJson(material)
  if (existing && (options.reuseExisting === true || existing.materialKey === materialKey)) return existing
  const op = { idempotencyKey: operationId(), material, materialKey, createdAt: new Date().toISOString() }
  try { s?.setItem(PREFIX + scope, JSON.stringify(op)) } catch { /* request can still continue */ }
  return op
}

export function clearPendingOperation(scope, idempotencyKey, storage) {
  const s = storageOrNull(storage)
  if (!s || !scope) return
  const existing = readPendingOperation(scope, s)
  if (!existing || !idempotencyKey || existing.idempotencyKey === idempotencyKey) {
    try { s.removeItem(PREFIX + scope) } catch { /* ignore */ }
  }
}

export function isAmbiguousFailure(error) {
  const status = Number(error?.status)
  return status === 0 || status === 408 || status === 429 || status >= 500 || !Number.isFinite(status)
}

export function settlePendingOperation(scope, op, error, storage) {
  if (!error || !isAmbiguousFailure(error)) clearPendingOperation(scope, op?.idempotencyKey, storage)
}

export const pendingOperationStorageKey = (scope) => PREFIX + scope
