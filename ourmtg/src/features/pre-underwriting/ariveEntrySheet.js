// The ARIVE entry sheet — what a person reads while they type this file into ARIVE.
//
// ── What this is NOT ────────────────────────────────────────────────────────
// It is not an integration. Nothing here talks to ARIVE, nothing here is submitted, and nothing
// here may say or imply that a transfer happened. ARIVE remains WCCM's system of record and the
// data gets there the way it always has: a person types it. Every string this module produces is
// written on that assumption, and `TRANSFER_DISCLAIMER` travels with the sheet so no screen can
// render it without saying so.
//
// ── What it IS ──────────────────────────────────────────────────────────────
// The transcription problem, solved. Keying a 1003 from a conversation transcript and a folder
// of PDFs means holding two windows open and hunting; keying it from an ordered list of
// label → value, grouped the way the destination form is grouped, is typing. So: one flat
// ordered list, every value as it should be TYPED, with the empties left in place and named.
//
// ── The rules the values follow ─────────────────────────────────────────────
//   • A field nobody answered appears, with an empty value and `missing: true`. Dropping it
//     would silently turn "we don't know" into "skip this box", which is the same bug class as
//     Number('') === 0 that has bitten this codebase three times.
//   • A secure field (SSN, account numbers) is NEVER carried. It appears as a row that says
//     where to get it, because the person keying has to enter something and needs to know that
//     this product deliberately does not hold it.
//   • An estimated or unconfirmed value is marked. A typist who cannot see which numbers are
//     soft will type all of them as if they were hard.
//   • Nothing is computed. No DTI, no LTV, no qualifying income. Those are conclusions, and a
//     conclusion typed into ARIVE by a person reading this sheet would be this product making an
//     underwriting judgement through a human's hands.

import { getField, SECTIONS, SECTION_LABELS } from '../conversational-1003/applicationCatalog.js'

export const TRANSFER_DISCLAIMER = Object.freeze([
  'This is a worksheet for manual entry. Nothing has been sent to ARIVE.',
  'ARIVE remains the system of record. This file is not in it until someone enters it.',
  'Values marked “estimated” or “unconfirmed” have not been verified against a document.',
])

export const NOT_MEANING = Object.freeze([
  'an approval or a pre-approval',
  'a credit decision',
  'an underwriting opinion',
  'a commitment to lend',
])

const pick = (v, locale = 'en') => (!v ? '' : typeof v === 'string' ? v : v[locale] || v.en || '')

/**
 * Build the sheet.
 *
 * @param {object} canonical  buildCanonicalExport() output
 * @param {object} [opts]
 * @param {string} [opts.locale]
 * @param {string} [opts.borrowerName]
 * @param {string} [opts.loanNumber]
 * @param {object} [opts.documents] organizeDocuments() output, to list what backs the numbers
 * @returns {{header: object, sections: Array, counts: object, disclaimer: Array, notMeaning: Array}}
 */
export function buildAriveEntrySheet(canonical, opts = {}) {
  const { locale = 'en', borrowerName = '', loanNumber = '', documents = null } = opts
  const rows = collect(canonical, locale)

  const sections = SECTIONS
    .map((key) => ({
      key,
      title: pick(SECTION_LABELS[key], locale) || key,
      rows: rows.filter((r) => r.section === key),
    }))
    .filter((s) => s.rows.length > 0)

  const counts = {
    total: rows.length,
    filled: rows.filter((r) => !r.missing && !r.redacted).length,
    missing: rows.filter((r) => r.missing).length,
    redacted: rows.filter((r) => r.redacted).length,
    unconfirmed: rows.filter((r) => !r.missing && !r.confirmed).length,
  }

  return {
    header: {
      borrowerName: borrowerName || null,
      loanNumber: loanNumber || null,
      generatedAt: canonical?.generatedAt || null,
      loanFileId: canonical?.loanFileId || null,
      applicationId: canonical?.applicationId || null,
      schemaVersion: canonical?.schemaVersion || null,
      catalogVersion: canonical?.catalogVersion || null,
    },
    sections,
    counts,
    // What still has no answer, in one place, so the person keying knows before they start
    // rather than discovering it in box 4a.
    outstanding: rows.filter((r) => r.missing).map((r) => ({ path: r.path, label: r.label, section: r.section })),
    contradictions: (canonical?.contradictions || []).map((c) => ({
      path: c.path,
      label: pick(getField(c.path)?.label, locale) || c.path,
      // The sheet refuses to pick. Two answers means a person asks the borrower, and typing
      // either one into ARIVE without asking is how a file gets a wrong number with a
      // confident-looking provenance.
      note: 'Two different answers were recorded. Confirm with the borrower before entering.',
    })),
    documents: documents ? {
      total: documents.total,
      unread: documents.unread,
      sections: documents.sections.map((s) => ({
        key: s.key, title: s.title,
        files: s.files.map((f) => ({ label: f.label, filedAs: f.filedAs, originalName: f.originalName, read: f.read })),
      })),
    } : null,
    disclaimer: TRANSFER_DISCLAIMER,
    notMeaning: NOT_MEANING,
  }
}

/**
 * Walk the canonical export back into flat rows.
 *
 * The canonical shape is a tree because that is what a downstream system wants. A person typing
 * wants a list, in catalog order, with the group indices spelled out ("Employer 2"), because
 * that is the order the destination form asks for them in.
 */
function collect(canonical, locale) {
  const rows = []
  const seen = new Set()

  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    if (isValueNode(node)) {
      if (seen.has(path)) return
      seen.add(path)
      rows.push(rowFor(path, node, locale))
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`))
      return
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, path ? `${path}.${key}` : key)
    }
  }

  walk(canonical?.parties, 'parties')
  walk(canonical?.loan, 'loan')

  // A required field nobody answered is not in the tree at all — it appears in `unresolved`.
  // Leaving it out here is how a blank box becomes an invisible box.
  for (const open of canonical?.unresolved || []) {
    if (seen.has(open.path)) continue
    seen.add(open.path)
    const f = getField(open.path)
    rows.push({
      path: open.path,
      section: open.section || f?.section || 'supplemental',
      label: labelFor(open.path, f, locale),
      value: '',
      missing: true,
      redacted: Boolean(f?.secureEntry),
      estimated: false,
      confirmed: false,
      note: f?.secureEntry ? SECURE_NOTE : 'Not answered yet.',
    })
  }

  return rows.sort(byCatalogOrder)
}

const SECURE_NOTE = 'Held securely and deliberately not exported. Collect it directly in ARIVE.'

function rowFor(path, node, locale) {
  const f = getField(path)
  const redacted = Boolean(node.redacted || f?.secureEntry)
  // display_value is what the borrower was shown and confirmed; the normalized value is for
  // machines. A person typing should retype what the borrower saw.
  const display = redacted ? '' : (node.display ?? node.value ?? '')
  const value = display === null || display === undefined ? '' : String(display)
  return {
    path,
    section: f?.section || 'supplemental',
    label: labelFor(path, f, locale),
    value,
    missing: !redacted && value === '',
    redacted,
    estimated: Boolean(node.estimated),
    confirmed: Boolean(node.confirmed),
    note: redacted ? SECURE_NOTE
      : node.estimated ? 'Estimated by the borrower — not verified against a document.'
        : !node.confirmed ? 'Not confirmed by the borrower.' : null,
    // The destination's own names for this box, so a typist can find it on an unfamiliar form.
    urla: f?.urla || null,
    ulad: f?.ulad || null,
  }
}

/** "Employer 2 — Employer name": the index a person needs, in front of the label. */
function labelFor(path, field, locale) {
  const base = pick(field?.label, locale) || fallbackLabel(path)
  const m = /\.(\w+)\[(\d+)\]\.[^.]+$/.exec(path)
  if (!m) return base
  const group = GROUP_NOUN[m[1]] || titleCase(m[1])
  return `${group} ${Number(m[2]) + 1} — ${base}`
}

const GROUP_NOUN = Object.freeze({
  employment: 'Employer', income: 'Income', assets: 'Account', liabilities: 'Debt',
  residence: 'Address', reo: 'Property', addresses: 'Address',
})

const titleCase = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase())

const fallbackLabel = (path) => String(path).split('.').pop().replace(/\[\d+\]/g, '')
  .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())

const SECTION_ORDER = new Map(SECTIONS.map((s, i) => [s, i]))
function byCatalogOrder(a, b) {
  const sa = SECTION_ORDER.get(a.section) ?? 99
  const sb = SECTION_ORDER.get(b.section) ?? 99
  if (sa !== sb) return sa - sb
  // Within a section, keep the borrower's index order: Employer 1 before Employer 2.
  return a.path.localeCompare(b.path, 'en', { numeric: true })
}

// A leaf in the canonical export is an object carrying the value plus its provenance. A branch
// is a plain container. `status` is present on every leaf and on no container, which is the one
// property that distinguishes them without guessing.
const isValueNode = (n) => n && typeof n === 'object' && !Array.isArray(n)
  && Object.prototype.hasOwnProperty.call(n, 'status')
  && Object.prototype.hasOwnProperty.call(n, 'source')
