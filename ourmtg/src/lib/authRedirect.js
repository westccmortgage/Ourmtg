// Authentication can begin from an invite, a protected file, or the general portal.
// Router state is browser-controlled input, so turn it into a same-origin path before it is
// handed to Supabase as an OAuth/email redirect. In particular, reject protocol-relative URLs
// and backslashes, which browsers can reinterpret as a different host.

const FALLBACK = '/portal'
const BASE = 'https://ourmtg.invalid'

export function safeAuthReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return FALLBACK
  }

  try {
    const url = new URL(value, BASE)
    if (url.origin !== BASE) return FALLBACK
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return FALLBACK
  }
}

export function absoluteAuthRedirect(value, origin = globalThis.location?.origin) {
  const path = safeAuthReturnPath(value)
  if (!origin) return path
  return `${String(origin).replace(/\/$/, '')}${path}`
}
