// Phase 1C — NOTIFICATION-INTENT model (§12). Phase 1C does NOT send anything. When a
// borrower-action task is created or materially changed, the gateway records an internal
// notification-INTENT (as a loan_events row, event_type 'notification.queued') carrying only the
// minimum to support a future outbox. No attachments, no sensitive data in metadata. Pure mapping.

// Map a task action → a borrower notification intent, or null if no borrower notice is warranted.
export const ACTION_INTENT = Object.freeze({
  create: 'borrower_task_created',
  reject: 'borrower_task_rejected',
  requestMoreInfo: 'borrower_task_more_information_needed',
  // due-soon is time-driven, emitted by a future scheduler, not a transition:
  dueSoon: 'borrower_task_due_soon',
})

// Build the intent descriptor. Returns null when the action does not notify the borrower.
// metadata is intentionally minimal (no PII, no financial detail).
export function notificationIntentFor(action, { taskId, loanFileId } = {}) {
  const intent = ACTION_INTENT[action]
  if (!intent) return null
  return {
    event_type: 'notification.queued',
    metadata: { intent, recipient_role: 'borrower', task_id: taskId || null, loan_file_id: loanFileId || null },
  }
}
