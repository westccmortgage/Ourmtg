// A pending invite that has to survive leaving the site entirely.
//
// THE BUG THIS FIXES: /invite sends a signed-out visitor to /login and remembers where to come
// back via router state. Router state lives in the tab. But signing in means going to an email
// app — and the message waiting there is often the account-confirmation mail, not the invite.
// Click that one and you arrive back signed in, on a page that has never heard of your invite,
// with no file linked and a "what brings you here?" chooser. The invite is still valid and
// still sitting in the inbox; nothing on screen says so.
//
// So the token is parked in localStorage, which outlives the tab, the redirect, and the trip
// through a mail client. Any landing spot that finds itself with no loan file checks here
// before concluding the person has nothing.
//
// It is not a credential. Redemption still goes through portal-invite-accept, which checks
// expiry, single use, and that the signed-in identity matches who the invite was issued to.
// Parking it only means the borrower does not have to find the email a second time.

const KEY = 'ourmtg.pendingInvite'
// Same shape the server mints: randomToken(16) → 32 hex characters.
const TOKEN_RE = /^[0-9a-f]{32}$/i

const store = () => {
  try { return globalThis.localStorage || null } catch { return null }  // Safari private mode throws
}

export function rememberInvite(token, go) {
  if (!TOKEN_RE.test(String(token || ''))) return
  try { store()?.setItem(KEY, JSON.stringify({ token, go: go || '', at: Date.now() })) } catch { /* full or blocked */ }
}

/**
 * The parked invite, or null. Anything malformed or older than a day is treated as absent —
 * a token from last week is far more likely to be a stale leftover than what this person is
 * trying to open right now.
 */
export function pendingInvite() {
  let raw
  try { raw = store()?.getItem(KEY) } catch { return null }
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (!TOKEN_RE.test(String(v?.token || ''))) return null
    if (!Number.isFinite(v.at) || Date.now() - v.at > 86_400_000) return null
    return { token: v.token, go: typeof v.go === 'string' ? v.go : '' }
  } catch { return null }
}

export function forgetInvite() {
  try { store()?.removeItem(KEY) } catch { /* nothing to clean up */ }
}
