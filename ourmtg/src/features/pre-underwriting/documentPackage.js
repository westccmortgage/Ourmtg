// The organized document package — what a processor hands to whoever keys the file into ARIVE.
//
// ── The problem ─────────────────────────────────────────────────────────────
// A borrower's uploads arrive named `IMG_4821.HEIC`, `Scan 2026-08-02 (1).pdf`, `doc.pdf`,
// `doc (1).pdf`. Somebody then opens each one to find out what it is, and re-types the answer
// into a second system. That is the manual half this package removes: the reading already
// happened, so the name can be derived from what was READ rather than from what was typed.
//
// ── The rule that governs all of it ─────────────────────────────────────────
// NOTHING IS RENAMED. This module produces a MAPPING — original name → filed-as name — and the
// stored object keeps the name it was uploaded with, forever. A mortgage file is an evidentiary
// record: the artifact a borrower sent must remain byte-identical and name-identical to what
// they sent, or a year from now nobody can prove which file was which. Every filed-as name is
// therefore derived, auditable, and reversible, and `basis` on each row says which facts
// produced it.
//
// ── What a derived name may contain ─────────────────────────────────────────
// Only what the document itself said: its type, its period, its institution. Never a conclusion,
// never a number off the document, never an account or Social Security number. A filename ends
// up in email subjects, shared folders, and screenshots; it is the least controlled surface in
// the product and is treated as such.

import { getDocumentType } from './documentCatalog.js'
import { DOCUMENT_SECTION, OPERATIONAL_SECTIONS, SECTION_TITLES } from './fileTasks.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Organize a file's documents into the sections a processor works in.
 *
 * @param {object} input
 * @param {Array} input.documents    loan_documents rows
 * @param {Array} input.extractions  live extractions, as listExtractions returns them
 * @param {string} [input.borrowerName]
 * @returns {{sections: Array, total: number, unread: number, mapping: Array}}
 */
export function organizeDocuments({ documents = [], extractions = [], borrowerName = '' } = {}) {
  const readBy = new Map()
  for (const e of extractions || []) {
    if (e?.documentId) readBy.set(e.documentId, e)
  }

  // Sequence within a (section, docKey) so two July pay stubs do not derive the same name. The
  // input order is the upload order, which is the order a person would expect them numbered in.
  const seq = new Map()
  const rows = []

  for (const d of documents || []) {
    if (!d?.id) continue
    const extraction = readBy.get(d.id) || null
    const part = fieldsOf(extraction)
    // The document's own claim about what it is beats the checklist slot it was filed under: a
    // borrower who uploads a W-2 into the pay-stub request has still uploaded a W-2.
    const docKey = extraction?.docKey || d.doc_key || null
    const type = getDocumentType(docKey)
    const section = DOCUMENT_SECTION[docKey] || 'documents'
    const bucket = `${section}:${docKey}`
    const n = (seq.get(bucket) || 0) + 1
    seq.set(bucket, n)

    const period = periodOf(docKey, part)
    const who = shortInstitution(part)
    const basis = []
    if (extraction?.docKey) basis.push(`type read from the document (${extraction.docKey})`)
    else if (d.doc_key) basis.push(`type from the checklist slot it was uploaded to (${d.doc_key})`)
    if (period) basis.push(`period read from the document (${period.raw})`)
    if (who) basis.push(`institution read from the document (${who})`)
    if (!extraction) basis.push('not read yet — name derived from the checklist alone')

    rows.push({
      documentId: d.id,
      section,
      sectionTitle: SECTION_TITLES[section] || 'Documents',
      docKey,
      label: type?.label || d.label || docKey || 'Document',
      // The name the borrower's device gave it. Kept exactly, including its spaces and case.
      originalName: baseName(d.storage_path) || d.label || '',
      // Derived, for whoever files this. Nothing is renamed in storage.
      filedAs: filedName({ borrowerName, docKey, type, period, who, seq: n, storagePath: d.storage_path }),
      // Why it is called that, in words a person can check against the document.
      basis,
      uploadedAt: d.uploaded_at || null,
      status: d.status || null,
      read: Boolean(extraction),
      readAt: extraction?.createdAt || null,
      needsHumanReview: Boolean(extraction?.needsHumanReview),
      // A confident disagreement between the slot and the page. Worth a processor's eye before
      // anything is keyed anywhere.
      misfiled: Boolean(extraction?.docKeyMismatch),
    })
  }

  const sections = OPERATIONAL_SECTIONS
    .map((key) => ({
      key,
      title: SECTION_TITLES[key] || key,
      files: rows.filter((r) => r.section === key),
    }))
    .filter((s) => s.files.length > 0)

  return {
    sections,
    total: rows.length,
    unread: rows.filter((r) => !r.read).length,
    // The audit trail, flat: every original name and what it is filed as. This is the artifact
    // that makes the renaming reversible a year from now.
    mapping: rows.map((r) => ({
      documentId: r.documentId, originalName: r.originalName, filedAs: r.filedAs, basis: r.basis,
    })),
  }
}

/**
 * `Nguyen_Income_PayStub_2026-08_1.pdf`
 *
 * Underscores and a leading surname because that is what sorts usefully in a shared folder, and
 * a folder sorted by borrower then category is the whole point of deriving a name at all.
 */
function filedName({ borrowerName, docKey, type, period, who, seq, storagePath }) {
  const parts = [
    surname(borrowerName),
    titleCase(DOCUMENT_SECTION[docKey] || 'documents'),
    camel(type?.label || docKey || 'Document'),
    who ? camel(who) : '',
    period?.label || '',
    String(seq),
  ].filter(Boolean)
  return `${parts.join('_')}${extension(storagePath)}`
}

/** What the document says it covers, if it said. Never inferred from the upload date. */
function periodOf(docKey, part) {
  const month = /^(\d{4})-(\d{2})$/.exec(String(part.statementMonth || ''))
  if (month) return { label: `${month[1]}-${month[2]}`, raw: part.statementMonth }

  const year = Number(part.taxYear)
  if (Number.isInteger(year) && year > 1900 && year < 2200) return { label: String(year), raw: String(year) }
  if (Array.isArray(part.taxYears) && part.taxYears.length) {
    const years = part.taxYears.filter((y) => Number.isInteger(Number(y))).map(Number).sort()
    if (years.length) {
      return years.length === 1
        ? { label: String(years[0]), raw: String(years[0]) }
        : { label: `${years[0]}-${years[years.length - 1]}`, raw: years.join(', ') }
    }
  }

  // A pay period is a range; the end date is what a person looks for when they sort a folder.
  const end = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(part.payPeriodEnd || part.periodEnd || ''))
  if (end) return { label: `${end[1]}-${end[2]}-${end[3]}`, raw: `${MONTHS[Number(end[2]) - 1]} ${end[3]}, ${end[1]}` }

  return null
}

// "JPMorgan Chase Bank, N.A." → "Chase"… no. It becomes "JPMorgan Chase Bank": shortening is
// dropping the legal suffix and capping the length, never guessing at a brand name, because a
// wrong institution on a filename is worse than a long one.
function shortInstitution(part) {
  const raw = String(part.institutionName || part.employerName || part.carrierName || '').trim()
  if (!raw) return ''
  return raw.split(/[,(]/)[0].trim().split(/\s+/).slice(0, 3).join(' ')
}

const surname = (name) => {
  const clean = String(name || '').trim().split(/\s+/).filter(Boolean)
  return clean.length ? camel(clean[clean.length - 1]) : 'Borrower'
}

// Safe for every filesystem, every email client, and every shell anyone might paste this into.
// Non-ASCII is transliterated away rather than preserved: a filename that renders as boxes in a
// shared folder is a filename nobody can search for.
const camel = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, ' ').trim()
  .split(' ').filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1))
  .join('')
  .slice(0, 40)

const titleCase = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase())

const baseName = (path) => String(path || '').split('/').pop() || ''

const extension = (path) => {
  const base = baseName(path)
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base)
  return m ? `.${m[1].toLowerCase()}` : ''
}

function fieldsOf(extraction) {
  const out = {}
  for (const f of extraction?.fields || []) {
    if (f && typeof f.name === 'string') out[f.name] = f.value
  }
  if (Array.isArray(extraction?.taxForms) && extraction.taxForms.length) {
    out.taxYears = [...new Set(extraction.taxForms.map((f) => f.taxYear).filter(Boolean))]
  }
  return out
}
