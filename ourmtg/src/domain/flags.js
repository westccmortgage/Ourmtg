// Phase 0 scaffolding — feature flags for OurMTG Phase 1+ capabilities.
//
// EVERY FLAG DEFAULTS TO false. Nothing in production reads these yet; they exist so future
// work can be added additively and stay dark until deliberately enabled. Do NOT flip any of
// these to true as part of Phase 0.
//
// When a flag is eventually consumed, resolve it through `flag(name)` so an env override
// (VITE_FF_<NAME> on the client, FF_<NAME> on the server) can enable it per-environment
// without editing this file. Absent env override => the default below (false).

export const FLAGS = Object.freeze({
  // Phase 2 — foundational new schema (see docs/OURMTG-TARGET-DATA-MODEL.md B1/B3).
  eventStream: false, // loan_events append-only domain-event stream
  deliveryTracking: false, // notification_deliveries + mailer delivery records

  // Phase 3 — owner-gated domain objects (B2/B4/B5/B6).
  taskModel: false, // loan_tasks (stored, assignable tasks)
  vendorOrders: false, // loan_vendor_orders (appraisal/title/escrow/insurance)
  cashToCloseLedger: false, // loan_cash_to_close (actual, not the client-side estimate)
  disclosuresEsign: false, // loan_disclosures / e-sign (vendor-vs-in-house decision pending)

  // Phase 4 — governed AI (B7).
  aiSupervisor: false, // AI File Supervisor; borrower-facing output stays LO-approval-gated

  // Phase 1B — borrower operations foundation (all default OFF; not wired to production DB).
  taskServiceEnabled: false, // pure task state-machine service wiring
  eventServiceEnabled: false, // pure append-only event service wiring
  borrowerWorkspaceV2: false, // enhanced borrower dashboard (needs-attention/progress/cash/etc.)
  loanTeamWorkspaceV2: false, // enhanced loan-team dashboard (blockers / what-changed-today)
  cashToClosePlanner: false, // deterministic cash-to-close planning view
  disclosureTracking: false, // provider-neutral disclosure state tracking UI/model
  thirdPartyTracking: false, // appraisal/title/escrow/insurance status placeholders
  notificationEvents: false, // provider-neutral notification event model
  aiSuggestions: false, // AI may only PROPOSE (never act); stays disabled
})

/**
 * Resolve a feature flag. Env override wins when present ("1"/"true" => on, "0"/"false" => off);
 * otherwise the compiled default from FLAGS (all false in Phase 0).
 * @param {keyof typeof FLAGS} name
 * @returns {boolean}
 */
export function flag(name) {
  const key = String(name)
  // Client (Vite) exposes import.meta.env; server (Netlify fn) exposes process.env. Guard both.
  const envName = key.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase() // camelCase -> SNAKE_CASE
  let override
  try {
    // eslint-disable-next-line no-undef
    if (typeof process !== 'undefined' && process?.env) override = process.env['FF_' + envName]
  } catch { /* not on server */ }
  if (override === undefined) {
    try {
      const m = import.meta
      if (m && m.env) override = m.env['VITE_FF_' + envName]
    } catch { /* not on client */ }
  }
  if (override !== undefined) return override === '1' || override === 'true'
  return FLAGS[key] === true
}
