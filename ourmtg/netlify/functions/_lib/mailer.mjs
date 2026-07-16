// Shared platform mailer — every email GR CRM sends to its USERS (brokers/agents)
// from admin@grcrm.com goes through here. Uses Resend SMTP with the platform key
// (same transport Supabase + support-submit already use, known-good on grcrm.com).
//
// Design rules:
//   • FAIL-SOFT: a send never throws into the caller. Returns { ok, skipped?, error? }.
//     Notifications must never break the action that triggered them (a lead is saved
//     even if the "you got a lead" email fails).
//   • If RESEND_PLATFORM_KEY is absent (local/dev) we no-op and return {ok:false,skipped}.
//   • All user-supplied strings MUST be passed through esc() before interpolation.
//   • Header-bound fields (to/subject/replyTo) pass through sanitizeHeader() to strip
//     CR/LF/control chars (SMTP header-injection defense; see Phase 1A security report).
import nodemailer from 'nodemailer'

const FROM = process.env.MAIL_FROM || 'West Coast Capital Mortgage <admin@grcrm.com>'
const APP_URL = (process.env.OURMTG_URL || 'https://ourmtg.com').replace(/\/$/, '')

export function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Strip CR/LF and other control characters from any value bound for an email HEADER
// (to / subject / replyTo). This neutralizes SMTP/header CRLF-injection in OUR usage
// regardless of the nodemailer version (the nodemailer <=9 HIGH advisories still apply —
// the dependency should be upgraded; this is defense-in-depth, not a CVE fix).
// Accepts a string or an array of addresses; returns the same shape, sanitized.
export function sanitizeHeader(value) {
  const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 998)
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value)
}

// Branded HTML shell. `bodyHtml` is trusted (built from esc()'d parts by callers).
// rows: optional [[label, value], …] rendered as a clean key/value table.
// cta: optional { text, url }. note: optional small grey footer line (already safe).
export function brandedEmail({ heading, intro, rows = [], cta, note, bodyHtml = '' }) {
  const rowsHtml = rows.length
    ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;width:100%">${rows
        .map(([l, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:14px;vertical-align:top;white-space:nowrap">${esc(l)}</td><td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : ''
  const ctaHtml = cta
    ? `<table cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="border-radius:8px;background:#2563eb"><a href="${esc(cta.url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px">${esc(cta.text)}</a></td></tr></table>`
    : ''
  const noteHtml = note ? `<p style="color:#9ca3af;font-size:13px;line-height:1.5;margin:18px 0 0">${note}</p>` : ''
  const introHtml = intro ? `<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 4px">${intro}</p>` : ''

  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="padding:20px 28px;border-bottom:1px solid #f0f0f0;background:#1e3a5f">
      <span style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-.3px">Our<span style="color:#7fb0ff">MTG</span></span>
    </td></tr>
    <tr><td style="padding:28px">
      ${heading ? `<h1 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 12px">${esc(heading)}</h1>` : ''}
      ${introHtml}${bodyHtml}${rowsHtml}${ctaHtml}${noteHtml}
    </td></tr>
    <tr><td style="padding:18px 28px;border-top:1px solid #f0f0f0;background:#fafafa">
      <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:0">
        West Coast Capital Mortgage Inc. · NMLS #2817729 · Equal Housing Opportunity<br>
        Your secure loan portal: <a href="${APP_URL}" style="color:#6b7280">${APP_URL.replace(/^https?:\/\//, '')}</a> ·
        Office <a href="tel:310-654-1577" style="color:#6b7280">310-654-1577</a><br>
        This is not a commitment to lend.
      </p>
    </td></tr>
  </table></body></html>`
}

// Send one platform email. Never throws. Returns { ok } | { ok:false, skipped } | { ok:false, error }.
export async function sendPlatformEmail({ to, subject, html, text, replyTo }) {
  const key = process.env.RESEND_PLATFORM_KEY
  if (!key) return { ok: false, skipped: 'RESEND_PLATFORM_KEY not set' }
  if (!to || !subject || !html) return { ok: false, error: 'Missing to/subject/html' }
  // Sanitize header-bound fields before they reach the SMTP layer (CRLF-injection defense).
  const safeTo = sanitizeHeader(to)
  const safeSubject = sanitizeHeader(subject)
  const safeReplyTo = replyTo ? sanitizeHeader(replyTo) : null
  if (!safeTo || (Array.isArray(safeTo) && safeTo.length === 0)) return { ok: false, error: 'Invalid recipient' }
  let transport
  try {
    transport = nodemailer.createTransport({
      host: 'smtp.resend.com', port: 465, secure: true,
      auth: { user: 'resend', pass: key },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    })
    await transport.sendMail({
      from: FROM, to: safeTo, subject: safeSubject,
      ...(safeReplyTo ? { replyTo: safeReplyTo } : {}),
      html,
      ...(text ? { text } : {}),
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || 'send failed' }
  } finally {
    try { transport?.close() } catch { /* ignore */ }
  }
}

export { APP_URL, FROM }
