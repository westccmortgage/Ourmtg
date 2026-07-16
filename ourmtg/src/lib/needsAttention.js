// Phase 1B — pure derivation of borrower "Needs Your Attention" items from EXISTING data
// (the checklist + conditions the gateway already returns). No new backend required. Pure and
// unit-testable. When the flag-gated task model lands, this is replaced by real loan_tasks.

// Document statuses that require the borrower to act.
const ACTION_DOC_STATUS = new Set(['missing', 'requested', 'rejected'])

// Map a checklist item to a borrower action item, or null if no action is needed.
function fromDoc(item) {
  if (!item || !ACTION_DOC_STATUS.has(item.status)) return null
  const reupload = item.status === 'rejected'
  return {
    key: `doc:${item.docKey}`,
    kind: 'document',
    title: reupload ? `Re-upload: ${item.label}` : `Upload: ${item.label}`,
    why: reupload
      ? (item.rejectReason ? `Needs another copy — ${item.rejectReason}` : 'The last copy needs another version.')
      : (item.why || 'Your loan team requested this document.'),
    status: item.status,
    blocking: true, // missing docs block the file from moving forward
    action: { label: reupload ? 'Re-upload' : 'Upload', to: 'documents' },
  }
}

// Map an open underwriting condition to an action item.
function fromCondition(c) {
  if (!c || c.status === 'cleared') return null
  return {
    key: `cond:${c.id}`,
    kind: 'condition',
    title: c.title || 'Underwriting condition',
    why: c.detail || 'Underwriting asked for this to move your loan forward.',
    status: c.status, // open | submitted
    blocking: c.status === 'open',
    action: { label: c.status === 'submitted' ? 'Under review' : 'Provide item', to: 'documents' },
  }
}

// Build the ordered borrower action list. Blocking items first, then documents before conditions.
export function borrowerActionItems({ checklistItems = [], conditions = [] } = {}) {
  const items = [
    ...checklistItems.map(fromDoc),
    ...conditions.map(fromCondition),
  ].filter(Boolean)
  const rank = (i) => (i.blocking ? 0 : 1) * 10 + (i.kind === 'document' ? 0 : 1)
  return items.sort((a, b) => rank(a) - rank(b))
}

export function attentionCount(items) {
  return items.filter((i) => i.status !== 'submitted').length
}
