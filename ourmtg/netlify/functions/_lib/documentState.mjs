// A removed mortgage document must disappear from the working file and its bytes must be
// destroyed, while a minimal audit tombstone remains.  The current production schema has no
// `removed` status, so the prefix is deliberately machine-only and keeps the rollout backwards
// compatible until the next reviewed migration can add first-class lifecycle columns.
export const REMOVED_DOCUMENT_PREFIX = '__REMOVED__:'

export function isRemovedDocument(document) {
  return String(document?.reject_reason || '').startsWith(REMOVED_DOCUMENT_PREFIX)
}

export function activeDocuments(documents) {
  return (documents || []).filter((document) => !isRemovedDocument(document))
}

export function removalTombstone(reason) {
  const clean = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (clean.length < 3) throw new Error('A removal reason is required')
  return `${REMOVED_DOCUMENT_PREFIX}${clean}`
}

