// upload-policy.mjs — pure document-upload validation policy (Phase 1A §7). No I/O.
//
// Financial documents are borrower-provided. We accept only a small allowlist of viewable
// document/image types and reject active/dangerous types (HTML/SVG can carry script;
// executables are never expected). This is DECLARED-type + filename hygiene — it is NOT
// content sniffing and NOT malware scanning (neither exists yet; see ScanProvider and the
// remaining-risk note in the security report). Server-controlled object paths
// (_lib/portal.storageDocPath) already prevent path escape regardless of filename.

// Accepted MIME types for borrower documents.
export const ALLOWED_DOC_MIME = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
])

// Extensions that must never be accepted (active content / executables), checked at ANY
// position so double extensions like "statement.pdf.exe" or "id.svg" are caught.
const DANGEROUS_EXT = new Set([
  'exe', 'com', 'scr', 'bat', 'cmd', 'sh', 'bash', 'ps1', 'vbs', 'js', 'mjs', 'cjs',
  'jar', 'msi', 'app', 'dmg', 'php', 'phtml', 'pl', 'py', 'rb', 'html', 'htm', 'xhtml',
  'svg', 'swf', 'jsp', 'asp', 'aspx', 'dll', 'so', 'bin',
])

export function isAllowedDocMime(mime) {
  return ALLOWED_DOC_MIME.includes(String(mime || '').trim().toLowerCase())
}

// True if ANY dot-segment after the first looks like a dangerous extension.
export function hasDangerousExtension(filename) {
  const parts = String(filename || '').toLowerCase().split('.')
  if (parts.length < 2) return false
  return parts.slice(1).some((seg) => DANGEROUS_EXT.has(seg.trim()))
}

// Normalize an untrusted filename to a safe display/label value: strip path separators,
// restrict to a safe charset (which also drops control chars), collapse whitespace, and cap
// length. Never used to build the storage path (that is fully server-controlled) — labels only.
export function normalizeFilename(filename) {
  const base = String(filename || '')
    .replace(/[\\/]/g, ' ')
    .replace(/[^a-zA-Z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128)
  return base || 'document'
}

// Validate a proposed upload from its declared content type (and optional filename).
// Returns { ok } or { ok:false, error }. Callers may treat an absent contentType as
// "unknown" and skip (see portal-doc-upload-url, which keeps contentType optional for
// backward compatibility with the current client).
export function validateUpload({ contentType, filename } = {}) {
  if (filename && hasDangerousExtension(filename)) {
    return { ok: false, error: 'This file type is not allowed' }
  }
  if (!isAllowedDocMime(contentType)) {
    return { ok: false, error: 'Unsupported file type. Upload a PDF, JPG, PNG, or HEIC.' }
  }
  return { ok: true }
}
