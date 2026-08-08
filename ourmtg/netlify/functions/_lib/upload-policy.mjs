// upload-policy.mjs — pure document-upload validation policy (Phase 1A §7). No I/O.
//
// Financial documents are borrower-provided. We accept only a small allowlist of viewable
// document/image types and reject active/dangerous types (HTML/SVG can carry script;
// executables are never expected). The signed-URL request uses declared-type + filename
// hygiene; completion and pre-underwriting use the byte-signature inspection below. Malware
// scanning is a separate provider boundary because a magic number is not an antivirus engine.
// Server-controlled object paths
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

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff])
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
])

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/**
 * Detect an allowed financial-document type from its bytes, never its filename or HTTP header.
 * This deliberately recognizes only formats the rest of the product can render/read. Unknown
 * input is null: a plausible extension must never turn arbitrary bytes into a mortgage document.
 */
export function sniffDocumentMime(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || [])
  if (startsWith(bytes, PDF)) return 'application/pdf'
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, JPEG)) return 'image/jpeg'

  // HEIC/HEIF are ISO base-media files. `ftyp` begins at byte 4 and the major or compatible
  // brand must identify a HEIF family; accepting every ISO-BMFF file would also accept video.
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brands = [ascii(bytes, 8, 12)]
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
      brands.push(ascii(bytes, offset, offset + 4))
    }
    const brand = brands.find((value) => HEIF_BRANDS.has(value))
    if (brand) return brand.startsWith('hei') ? 'image/heic' : 'image/heif'
  }
  return null
}

function sameDocumentMime(declared, detected) {
  const a = String(declared || '').toLowerCase().split(';')[0].trim()
  if (!a) return true
  if (a === detected) return true
  return ['image/heic', 'image/heif'].includes(a)
    && ['image/heic', 'image/heif'].includes(detected)
}

/** Verify actual bytes and, when supplied, require the declared MIME to agree with them. */
export function inspectDocumentBytes(input, { declaredContentType = null } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || [])
  if (bytes.byteLength === 0) return { ok: false, code: 'empty_file', error: 'The uploaded file is empty.' }
  const detectedContentType = sniffDocumentMime(bytes)
  if (!detectedContentType) {
    return {
      ok: false,
      code: 'unsupported_file_content',
      error: 'The uploaded file is not a supported PDF, JPG, PNG, or HEIC document.',
    }
  }
  if (!sameDocumentMime(declaredContentType, detectedContentType)) {
    return {
      ok: false,
      code: 'content_type_mismatch',
      error: 'The file contents do not match the file type reported by the upload.',
      detectedContentType,
    }
  }
  return { ok: true, detectedContentType }
}
