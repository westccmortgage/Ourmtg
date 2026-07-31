// Where an invite opens after it is redeemed.
//
// This is a routing decision made from a value that arrives in a URL, which means it is
// untrusted input: the `go` parameter reaches us from an email, a text message, or someone
// editing the address bar. So it is an allowlist of two known destinations, never a path
// fragment that gets interpolated into a route. An unrecognized value is not an error worth
// showing anyone — it just falls back to the portal.
//
// Pure on purpose: no React, no router, no browser. The pages import it; the tests can too.

export const INVITE_DESTINATIONS = Object.freeze(['application', 'documents'])

/** True IFF `go` names a destination we are willing to route to. */
export const isInviteDestination = (go) => INVITE_DESTINATIONS.includes(go)

/**
 * The in-app path an invite should land on once `portal-invite-accept` has granted access.
 * Returns the portal for anything unrecognized, and for a missing loan file id — a link that
 * redeemed without telling us which file it belongs to has nowhere specific to go.
 */
export function landingPath(go, loanFileId) {
  if (!loanFileId || !isInviteDestination(go)) return '/portal'
  return go === 'application'
    ? `/application/assistant/${loanFileId}`
    : `/portal/documents/${loanFileId}`
}

/**
 * The /invite href for a token, preserving a known destination across the sign-in round trip.
 * Without this the destination is dropped for anyone not already signed in — which is most
 * people opening an emailed link — and every application link quietly becomes a portal link.
 */
export function inviteHref(token, go) {
  const base = `/invite?token=${encodeURIComponent(token)}`
  return isInviteDestination(go) ? `${base}&go=${go}` : base
}

/**
 * Which loan file "my application" means, given this user's portal_access grants.
 *
 * Only the borrower side counts. A loan officer has grants too — theirs say `owner` — but they
 * have no application of their own to fill out, so for them the answer is "none" rather than
 * somebody else's file.
 *
 * @returns {{kind:'one', loanFileId:string} | {kind:'choose', files:Array} | {kind:'none'}}
 */
export function resolveMyApplication(grants) {
  const mine = (Array.isArray(grants) ? grants : [])
    .filter((g) => g && (g.visibility === 'borrower' || g.visibility === 'coborrower'))
    .filter((g) => g.loan_file_id)
  if (mine.length === 0) return { kind: 'none' }
  if (mine.length === 1) return { kind: 'one', loanFileId: mine[0].loan_file_id }
  return { kind: 'choose', files: mine }
}

// Invite tokens are randomToken(16) server-side: 32 hex characters. Anything else never came
// from a link we minted — most often a text message that clipped the tail — so it is rejected
// before redemption rather than sent onward to fail there.
const TOKEN_RE = /^[0-9a-f]{32}$/i
export const isInviteToken = (t) => TOKEN_RE.test(String(t || ''))
