// Autopilot Pre-Underwriting — client-side feature flag.
//
// PRESENTATION ONLY. This decides whether the panel is mounted; it authorizes nothing. Every
// pre-underwriting-* function independently checks the SERVER flag (PRE_UNDERWRITING_ENABLED),
// so flipping this alone cannot expose a finding to anyone.
//
// Default: OFF. Anything other than "1"/"true" is off.

export const CLIENT_FLAG = 'VITE_FF_PRE_UNDERWRITING'

export function preUnderwritingEnabled(env) {
  let raw
  try {
    raw = (env || import.meta.env)?.[CLIENT_FLAG]
  } catch {
    raw = env?.[CLIENT_FLAG]
  }
  return raw === '1' || raw === 'true'
}
