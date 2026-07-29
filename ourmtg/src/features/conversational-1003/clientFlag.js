// Conversational 1003 — client-side feature flag.
//
// PRESENTATION ONLY. This decides whether the route and UI are mounted; it authorizes nothing.
// Every application-* function independently checks the SERVER flag (CONVERSATIONAL_1003_ENABLED),
// so flipping the client flag alone cannot expose the feature — the same rule the task pilot
// follows (see netlify/functions/_lib/featureFlags.mjs).
//
// Default: OFF. Anything other than "1"/"true" is off.

export const CLIENT_FLAG = 'VITE_FF_CONVERSATIONAL_1003'

export function conversational1003Enabled(env) {
  let raw
  try {
    raw = (env || import.meta.env)?.[CLIENT_FLAG]
  } catch {
    raw = env?.[CLIENT_FLAG]
  }
  return raw === '1' || raw === 'true'
}
