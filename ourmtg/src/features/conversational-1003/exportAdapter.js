// Conversational 1003 — export and the downstream adapter boundary (§27).
//
// WHAT THIS IS: a canonical, versioned JSON representation of collected borrower information,
// plus an adapter interface a future LOS/AUS integration can implement.
//
// WHAT THIS IS NOT: a DU, LPA, MISMO, ULAD, or Arive submission. The output has NOT been
// validated against any of those specifications, and no adapter for any of them exists. Do not
// describe this output as any of those formats. Nothing here submits anything anywhere.

import { APPLICATION_SCHEMA_VERSION, CATALOG_VERSION, RULES_VERSION } from './types.js'
import { getField, CATALOG_META } from './applicationCatalog.js'

export const EXPORT_FORMAT = 'ourmtg.conversational1003.v1'

/**
 * Canonical application JSON. Structured by party and group so a downstream mapper has
 * something stable to read, rather than a flat bag of dotted paths.
 *
 * Every value carries its provenance: status, source, whether it is an estimate, and whether a
 * human confirmed it. A consumer that treats an unconfirmed candidate as fact is doing so
 * knowingly.
 */
export function buildCanonicalExport(state, report, { applicationId, loanFileId, parties = [], generatedAt }) {
  const out = {
    format: EXPORT_FORMAT,
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    rulesVersion: RULES_VERSION,
    fieldCount: CATALOG_META.fieldCount,
    generatedAt: generatedAt || null,
    applicationId: applicationId || null,
    loanFileId: loanFileId || null,
    completeness: {
      percent: report.percent,
      totalRequired: report.totalRequired,
      resolvedRequired: report.resolvedRequired,
      status: report.status,
      meaning: report.meaning,
      notMeaning: report.notMeaning,
    },
    parties: [],
    loan: {},
    unresolved: report.openFields.map((o) => ({ path: o.path, section: o.section, status: o.status })),
    structuralGaps: report.structural,
    contradictions: report.conflicts,
  }

  for (const [path, view] of Object.entries(state.fields)) {
    const f = getField(path)
    if (!f || view.status === 'superseded') continue
    const value = {
      value: f.secureEntry ? null : view.normalized_value,
      display: f.secureEntry ? '••••' : view.display_value,
      status: view.status,
      source: view.source,
      estimated: Boolean(view.estimated),
      confirmed: Boolean(view.confirmed_at),
      // Secure values are NEVER exported, in any form. A downstream system that needs the
      // plaintext must obtain it through a channel this feature does not provide.
      redacted: Boolean(f.secureEntry),
      urla: f.urla,
      ulad: f.ulad,
      mismo: f.mismo,
    }
    assign(out, path, value)
  }
  return out
}

// parties[0].employment[1].startDate → out.parties[0].employment[1].startDate
function assign(root, path, value) {
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let node = root
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]
    const nextIsIndex = /^\d+$/.test(segments[i + 1])
    if (node[key] === undefined) node[key] = nextIsIndex ? [] : {}
    node = node[key]
  }
  node[segments[segments.length - 1]] = value
}

/** Human-readable borrower summary — what the borrower reviews before attesting. */
export function buildBorrowerSummary(state, report, { locale = 'en' } = {}) {
  const lines = []
  for (const [path, view] of Object.entries(state.fields)) {
    const f = getField(path)
    if (!f || view.status === 'superseded') continue
    const label = (f.label && (f.label[locale] || f.label.en)) || path
    const value = f.secureEntry ? '••••' : (view.display_value ?? '—')
    lines.push(`${label}: ${value}${view.estimated ? ' (estimate)' : ''}`)
  }
  return { locale, percent: report.percent, lines }
}

/** Unresolved-items report, for the team and for the borrower's "what's left" view. */
export function buildUnresolvedReport(report) {
  return {
    total: report.openFields.length + report.structural.length + report.conflicts.length,
    fields: report.openFields.map((o) => ({ path: o.path, section: o.section, status: o.status, requirement: o.requirement })),
    structural: report.structural.map((s) => ({ kind: s.kind, section: s.group, partyIndex: s.partyIndex })),
    contradictions: report.conflicts.map((c) => ({ path: c.path, values: c.values })),
  }
}

/**
 * The downstream adapter boundary. No implementation ships in this phase — this is the shape a
 * future LOS/AUS integration must satisfy, and the honest default is one that refuses.
 *
 * @typedef {object} ApplicationDestinationAdapter
 * @property {string} name
 * @property {(payload:object)=>{ok:boolean, errors:string[]}} validate
 * @property {(payload:object)=>{ok:boolean, preview:object}} preview
 * @property {(payload:object)=>Promise<{ok:boolean, reference?:string, error?:string}>} export
 */

/**
 * The only adapter that exists. It validates the canonical shape, previews it, and REFUSES to
 * export — because there is nothing approved to export to. Replacing this with a real adapter
 * is a separate, separately-reviewed piece of work (§31: no Arive/DU/LPA submission).
 */
export function createNullDestinationAdapter() {
  return {
    name: 'none',

    validate(payload) {
      const errors = []
      if (!payload || payload.format !== EXPORT_FORMAT) errors.push('unexpected_format')
      if (!payload?.schemaVersion) errors.push('missing_schema_version')
      if (!Array.isArray(payload?.parties) || payload.parties.length === 0) errors.push('no_parties')
      if (payload?.unresolved?.length) errors.push('unresolved_required_fields')
      if (payload?.contradictions?.length) errors.push('unresolved_contradictions')
      // Deliberately NOT validated: DU/LPA/MISMO/ULAD conformance. We do not implement those
      // specifications and must not imply that passing this check means anything to them.
      return { ok: errors.length === 0, errors }
    },

    preview(payload) {
      return {
        ok: true,
        preview: {
          format: payload?.format,
          schemaVersion: payload?.schemaVersion,
          parties: payload?.parties?.length ?? 0,
          percent: payload?.completeness?.percent ?? 0,
          unresolved: payload?.unresolved?.length ?? 0,
          note: 'Preview only. No destination is configured and nothing will be transmitted.',
        },
      }
    },

    async export() {
      return {
        ok: false,
        error: 'no_destination_configured',
        detail: 'No LOS or AUS adapter is implemented. This build cannot submit an application anywhere.',
      }
    },
  }
}

/**
 * Placeholder for a future Arive adapter. It exists only to mark the boundary; constructing it
 * throws so nobody can mistake it for a working integration (§27, §31).
 */
export function createAriveAdapter() {
  throw new Error('Arive adapter is not implemented. Submission to Arive is out of scope for this phase.')
}
