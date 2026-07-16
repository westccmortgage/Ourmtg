// Phase 1C Functional Completion — browser-side pending-operation registry.
//
// A logical mutation receives one idempotency key BEFORE the first request. The key,
// material payload and expected revision remain in localStorage across double-click,
// timeout and refresh recovery. Callers clear the entry only after a definitive result.

const PREFIX = 'ourmtg.pending.v1:'

function storageOrNull(storage) {
  if (storage) return storage
  try { return globalThis.localStorage || null } catch { return null }
}

function operationId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch { /* fallback below */ }
  const rand = Math.random().toString(36).slice(2)
  return `op-${Date.now().toString(36)}-${rand}`
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
    const raw = s.getItem(PREFIX + scope)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.idempotencyKey || !parsed?.materialKey) return null
    return parsed
  } catch {
    return null
  }
}

export function getOrCreatePendingOperation(scope, material, storage) {
  const s = storageOrNull(storage)
  const materialKey = stableJson(material)
  const existing = readPendingOperation(scope, s)
  if (existing && existing.materialKey === materialKey) return existing

  const op = {
    idempotencyKey: operationId(),
    material,
    materialKey,
    createdAt: new Date().toISOString(),
  }
  try { s?.setItem(PREFIX + scope, JSON.stringify(op)) } catch { /* in-memory request still works */ }
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
