// Conversational 1003 — deterministic completeness (§13).
//
// The model NEVER decides whether the application is complete. Completeness is a pure count:
//   applicable required fields  vs  resolved applicable required fields
// plus structural requirements (history coverage, minimum records) and blocking conflicts.
//
// "Complete" here means COLLECTED AND ATTESTED. It never means approved, pre-approved,
// verified, underwritten, submitted to an AUS, or cleared to close — see §13 and the strings
// the UI is required to use.

import { RESOLVED_STATUSES } from './types.js'
import { CATALOG, getField, instantiate, groupOf, SECTIONS } from './applicationCatalog.js'
import {
  evaluateRequirement, analyzeHistory,
  REQUIRED_EMPLOYMENT_HISTORY_MONTHS, REQUIRED_RESIDENCE_HISTORY_MONTHS,
} from './applicationRules.js'
import { fieldStatus, fieldValue, groupIndices } from './applicationReducer.js'

// Repeating groups and the minimum number of records the application needs. `gatedBy` names a
// boolean field that turns the whole group on/off; when it is false the group is not applicable.
export const GROUPS = Object.freeze({
  residence: { min: 1, gatedBy: null },
  employment: { min: 1, gatedBy: null },
  income: { min: 1, gatedBy: null },
  assets: { min: 1, gatedBy: null },
  liabilities: { min: 1, gatedBy: 'hasAnyLiabilities' },
  reo: { min: 1, gatedBy: 'ownsOtherRealEstate' },
})

const PARTY_SCALAR = CATALOG.filter((d) => d.scope === 'party' && !/\w+\[\]\./.test(d.path.replace('parties[].', '')))
const LOAN_SCALAR = CATALOG.filter((d) => d.scope === 'loan')
const GROUP_FIELDS = Object.fromEntries(
  Object.keys(GROUPS).map((g) => [g, CATALOG.filter((d) => groupOf(d.path) === g)]),
)

const isResolvedStatus = (s) => RESOLVED_STATUSES.includes(s)

/**
 * Enumerate every field the application currently requires, given its own answers.
 * Returns [{ path, section, partyIndex, requirement }] where requirement is 'required'
 * (unconditional) or the rule id that made it required.
 */
export function applicableRequiredFields(state) {
  const out = []
  const partyCount = Math.max(1, state.partyCount || 1)

  for (let p = 0; p < partyCount; p++) {
    for (const def of PARTY_SCALAR) {
      const path = instantiate(def.path, p)
      pushIfRequired(state, def, path, p, out)
    }
    for (const [group, cfg] of Object.entries(GROUPS)) {
      if (cfg.gatedBy && fieldValue(state, `parties[${p}].${cfg.gatedBy}`) !== true) continue
      const indices = groupIndices(state, p, group)
      // A gated-on or always-required group with no records yet still needs its first record;
      // that is reported as a structural requirement, not as phantom field paths.
      for (const i of indices) {
        for (const def of GROUP_FIELDS[group]) {
          const path = instantiate(def.path, p, i)
          pushIfRequired(state, def, path, p, out)
        }
      }
    }
  }
  for (const def of LOAN_SCALAR) {
    pushIfRequired(state, def, def.path, null, out)
  }
  return out
}

function pushIfRequired(state, def, path, partyIndex, out) {
  const req = evaluateRequirement(state, path)
  if (req === true) {
    out.push({ path, section: def.section, partyIndex, requirement: def.requiredWhen || 'required' })
  }
}

/**
 * Structural requirements that are not single fields: minimum records per group and the
 * continuous 24-month employment/residence history (§12).
 */
export function structuralRequirements(state, { asOfMonth }) {
  const reqs = []
  const partyCount = Math.max(1, state.partyCount || 1)

  for (let p = 0; p < partyCount; p++) {
    for (const [group, cfg] of Object.entries(GROUPS)) {
      if (cfg.gatedBy) {
        const gate = fieldValue(state, `parties[${p}].${cfg.gatedBy}`)
        if (gate == null) continue          // the gating question itself is already a required field
        if (gate !== true) continue         // answered "no" → group not applicable
      }
      const count = groupIndices(state, p, group).length
      if (count < cfg.min) {
        reqs.push({ kind: 'min_records', partyIndex: p, group, have: count, need: cfg.min })
      }
    }

    // Residence history must reach back 24 months with no unexplained gap.
    const resHistory = collectHistory(state, p, 'residence')
    if (resHistory) {
      const a = analyzeHistory(resHistory, { requiredMonths: REQUIRED_RESIDENCE_HISTORY_MONTHS, asOfMonth })
      if (a.needsAnother) reqs.push({ kind: 'history_backfill', partyIndex: p, group: 'residence', analysis: a })
      for (const g of a.gaps) reqs.push({ kind: 'history_gap', partyIndex: p, group: 'residence', gap: g })
      for (const o of a.overlaps) reqs.push({ kind: 'history_overlap', partyIndex: p, group: 'residence', overlap: o })
    }

    // Employment history — skipped for retired/other classifications, which have no VOE window.
    const empHistory = collectHistory(state, p, 'employment')
    const needsEmploymentWindow = (empHistory || []).some((r) =>
      ['w2_employee', 'self_employed', 'contractor_1099', 'military'].includes(r.employmentType))
    if (empHistory && needsEmploymentWindow) {
      const a = analyzeHistory(empHistory, { requiredMonths: REQUIRED_EMPLOYMENT_HISTORY_MONTHS, asOfMonth })
      if (a.needsAnother) reqs.push({ kind: 'history_backfill', partyIndex: p, group: 'employment', analysis: a })
      for (const g of a.gaps) reqs.push({ kind: 'history_gap', partyIndex: p, group: 'employment', gap: g })
      for (const o of a.overlaps) reqs.push({ kind: 'history_overlap', partyIndex: p, group: 'employment', overlap: o })
    }
  }
  return reqs
}

/**
 * Collect the date span of each record in a history group.
 *
 * Returns null when any existing record is still missing its start date: we cannot judge
 * whether the two-year window is covered until the records we already have are filled in, and
 * asking "where did you work before that?" while the current job's start date is still blank
 * is exactly the kind of premature question this engine exists to avoid.
 */
function collectHistory(state, partyIndex, group) {
  const indices = groupIndices(state, partyIndex, group)
  if (!indices.length) return null
  const records = indices.map((i) => {
    const base = `parties[${partyIndex}].${group}[${i}]`
    return {
      index: i,
      start: fieldValue(state, `${base}.startDate`),
      end: fieldValue(state, `${base}.endDate`),
      isCurrent: fieldValue(state, `${base}.isCurrent`),
      employmentType: fieldValue(state, `${base}.employmentType`),
    }
  })
  const incomplete = records.some((r) => !r.start || (r.isCurrent !== true && !r.end))
  if (incomplete) return null
  return records.map((r) => ({ ...r, isCurrent: r.isCurrent === true }))
}

/**
 * The full completeness report. This is what the borrower progress bar, the team dashboard,
 * and the attestation gate all read — there is one calculation, not three.
 */
export function computeCompleteness(state, { asOfMonth, attested = false, teamAccepted = false } = {}) {
  const required = applicableRequiredFields(state)
  const structural = structuralRequirements(state, { asOfMonth })

  const open = []
  const clarifications = []
  let resolved = 0

  for (const r of required) {
    const status = fieldStatus(state, r.path)
    if (isResolvedStatus(status)) { resolved++; continue }
    if (status === 'needs_clarification') clarifications.push({ ...r, status })
    open.push({ ...r, status })
  }

  const conflicts = Object.entries(state.conflicts || {}).map(([path, c]) => ({
    path, section: getField(path)?.section || null, values: c.values, since: c.since,
  }))

  // Section rollup for the borrower review view (§18).
  const bySection = {}
  for (const s of SECTIONS) bySection[s] = { required: 0, resolved: 0, open: 0, conflicts: 0 }
  for (const r of required) {
    const b = bySection[r.section]; if (!b) continue
    b.required++
    if (isResolvedStatus(fieldStatus(state, r.path))) b.resolved++; else b.open++
  }
  for (const c of conflicts) if (bySection[c.section]) bySection[c.section].conflicts++
  for (const st of structural) {
    const sec = st.group && bySection[st.group] ? st.group : null
    if (sec) bySection[sec].open++
  }
  for (const s of SECTIONS) {
    const b = bySection[s]
    b.state = b.conflicts > 0 ? 'needs_attention'
      : b.required === 0 ? 'not_applicable'
        : b.open === 0 ? 'complete' : 'in_progress'
  }

  const totalRequired = required.length + structural.length
  const totalResolved = resolved
  const everythingResolved = open.length === 0 && structural.length === 0 && conflicts.length === 0

  // Never report 100% while anything is unresolved (§13). The bar is capped at 99 until the
  // engine can prove there is nothing left.
  const rawPercent = totalRequired === 0 ? 0 : Math.floor((totalResolved / totalRequired) * 100)
  const percent = everythingResolved ? 100 : Math.min(rawPercent, 99)

  return {
    status: deriveStatus({ everythingResolved, conflicts, clarifications, attested, teamAccepted, hasAny: state.events.length > 0 }),
    percent,
    totalRequired,
    resolvedRequired: totalResolved,
    openFields: open,
    clarifications,
    conflicts,
    structural,
    bySection,
    everythingResolved,
    // Explicitly enumerated so no caller can mistake collection for a credit decision.
    meaning: 'information_collected_and_attested',
    notMeaning: Object.freeze(['approved', 'pre_approved', 'verified', 'underwritten', 'submitted_to_aus', 'cleared_to_close']),
  }
}

function deriveStatus({ everythingResolved, conflicts, clarifications, attested, teamAccepted, hasAny }) {
  if (teamAccepted) return 'accepted_into_loan_file'
  if (attested) return 'borrower_attested'
  if (!hasAny) return 'not_started'
  if (conflicts.length > 0 || clarifications.length > 0) return 'needs_clarification'
  if (everythingResolved) return 'ready_for_borrower_review'
  return 'in_progress'
}

/** Guard the attestation gate: the borrower may only attest when nothing required is open. */
export function canAttest(report) {
  return Boolean(report && report.everythingResolved)
}
