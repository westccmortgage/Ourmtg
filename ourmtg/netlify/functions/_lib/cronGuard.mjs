// cronGuard.mjs — schedule-only invocation gate for Netlify cron functions.
//
// isScheduledInvocation(req) returns true when EITHER:
//   (a) The request carries Netlify's scheduled-event marker: header x-nf-event === 'schedule'.
//       Netlify sets this on all scheduled invocations; x-nf-* headers cannot be spoofed by
//       external callers through the Netlify edge.
//   (b) Header x-cron-secret equals process.env.CRON_SECRET (non-empty string), as a
//       manual/testing escape hatch. Also used for scheduled HTTP pings when a Netlify
//       runtime version doesn't forward x-nf-event.
//
// NOTE for ops: If x-nf-event is not present in your Netlify runtime version, set CRON_SECRET
// in your Netlify environment and trigger the cron via a scheduled HTTP ping that sends
//   x-cron-secret: <CRON_SECRET>
// instead. Never expose CRON_SECRET publicly — treat it like a password.

export function isScheduledInvocation(req) {
  // (a) Netlify's scheduled-event marker. VERIFIED EMPIRICALLY on this site
  //     (2026-06-10): the scheduler sends `x-netlify-event` + `x-webhook-signature`,
  //     and the Netlify bootstrap REJECTS (HTTP 500, before our handler runs) any
  //     external request carrying x-netlify-event whose signature doesn't verify —
  //     so if this header reaches our code, the invocation is genuinely Netlify's.
  if (req.headers.get('x-netlify-event')) return true
  // Older/alternate runtime marker, kept for safety.
  if (req.headers.get('x-nf-event') === 'schedule') return true

  // (b) Manual/testing escape hatch via a shared secret.
  const secret = process.env.CRON_SECRET
  if (secret && secret.length > 0 && req.headers.get('x-cron-secret') === secret) return true

  return false
}

// rejectionLog logs the header *keys* (NOT values) of a rejected request so
// misfires are diagnosable in function logs without leaking secrets.
export function rejectionLog(req, label) {
  const keys = [...req.headers.keys()].join(', ')
  console.warn(`[${label}] Forbidden: not a scheduled invocation. Received header keys: ${keys}`)
}

// heartbeat records "this cron ran" in cron_heartbeat so ops can verify the
// Netlify scheduler actually gets past the gate (vs silently 403ing).
// Best-effort: never throws, never affects the cron's result.
export async function heartbeat(db, name, note) {
  try {
    await db.from('cron_heartbeat').upsert(
      { name, last_run: new Date().toISOString(), ...(note ? { note } : {}) },
      { onConflict: 'name' },
    )
  } catch { /* non-fatal */ }
}
