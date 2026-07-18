// Phase 1C EXT-10 — FAIL-CLOSED server-side feature flags for the task pilot. VITE_FF_* is
// presentation only and NEVER authorizes backend use; the server checks these env flags.
// Missing / malformed / false => disabled. Pure (env injectable for tests).

function on(v) { return v === 'true' || v === '1' } // strict: anything else is OFF

export function serverFlag(name, env = process.env) {
  return on(env?.[name])
}
// Convenience gates used by the task endpoints.
export function taskPilotEnabled(env = process.env) { return serverFlag('FF_TASK_PILOT', env) }
export function loanTeamTaskPilotEnabled(env = process.env) { return serverFlag('FF_LOAN_TEAM_TASK_PILOT', env) }
