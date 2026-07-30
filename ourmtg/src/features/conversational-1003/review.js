// Conversational 1003 — the borrower review view (§18) and the team review view (§19).
//
// Two projections of the same state, differing in exactly one way that matters: the team view
// exposes provenance (source, confidence, why an item needs review) and the borrower view
// exposes plain language. NEITHER exposes a sensitive value — secure fields are masked in
// both, because the loan team does not need to see a full SSN to work the file (§19).

import { SECTIONS, SECTION_LABELS, getField, chipLabel } from './applicationCatalog.js'
import { isResolved } from './types.js'

const pick = (v, locale) => (!v ? '' : typeof v === 'string' ? v : v[locale] || v.en || '')

// Never render a stored value for a secure field, in any view.
function safeDisplay(path, view) {
  const f = getField(path)
  if (!f) return null
  if (f.secureEntry) return view?.normalized_value ? '••••' : null
  return view?.display_value ?? null
}

/**
 * Borrower-facing review, grouped the way §18 requires, with a per-group state the UI can
 * render as a badge: complete / needs attention / waiting for confirmation / skipped / n-a.
 */
export function buildReview(state, report, { locale = 'en' } = {}) {
  const groups = []
  for (const section of SECTIONS) {
    const rollup = report.bySection[section] || { required: 0, resolved: 0, open: 0, conflicts: 0 }
    const items = []

    for (const [path, view] of Object.entries(state.fields)) {
      const f = getField(path)
      if (!f || f.section !== section) continue
      if (view.status === 'superseded') continue
      items.push({
        path,
        label: chipLabel(path, locale),
        question: pick(f.label, locale),
        value: safeDisplay(path, view),
        status: view.status,
        estimated: Boolean(view.estimated),
        secure: Boolean(f.secureEntry),
        editable: true,
        conflictValues: state.conflicts[path]?.values || null,
      })
    }

    const openHere = report.openFields.filter((o) => o.section === section)
    const pendingConfirm = items.filter((i) => i.status === 'candidate').length
    const structuralHere = report.structural.filter((s) => s.group === section)

    groups.push({
      section,
      label: pick(SECTION_LABELS[section], locale),
      items: items.sort((a, b) => a.label.localeCompare(b.label)),
      counts: {
        required: rollup.required,
        resolved: rollup.resolved,
        open: openHere.length + structuralHere.length,
        conflicts: rollup.conflicts,
        pendingConfirmation: pendingConfirm,
      },
      state: groupState({ rollup, pendingConfirm, openHere, structuralHere }),
    })
  }
  return { groups, percent: report.percent, status: report.status }
}

function groupState({ rollup, pendingConfirm, openHere, structuralHere }) {
  if (rollup.conflicts > 0) return 'needs_attention'
  if (rollup.required === 0 && openHere.length === 0 && structuralHere.length === 0) return 'not_applicable'
  if (openHere.length === 0 && structuralHere.length === 0 && pendingConfirm === 0) return 'complete'
  if (openHere.length === 0 && structuralHere.length === 0 && pendingConfirm > 0) return 'waiting_for_confirmation'
  return 'in_progress'
}

/**
 * "Since your last visit" (§18). Pure: the caller supplies the cutoff, so this is testable and
 * does not read a clock.
 */
export function buildSinceLastVisit(state, { since, locale = 'en' } = {}) {
  if (!since) return null
  const saved = []
  const changed = []
  for (const [path, history] of Object.entries(state.history)) {
    for (const ev of history) {
      if (!ev.created_at || ev.created_at <= since) continue
      const entry = { path, label: chipLabel(path, locale), value: safeDisplay(path, ev), status: ev.status }
      if (ev.previous_event_id) changed.push(entry)
      else saved.push(entry)
    }
  }
  return { since, saved, changed }
}

/**
 * Team-facing review (§19). Adds provenance and an explicit reason each item needs a human —
 * so the loan officer never has to guess why something is flagged.
 */
export function buildTeamReview(state, report, { locale = 'en', parties = [] } = {}) {
  const items = []
  for (const [path, view] of Object.entries(state.fields)) {
    const f = getField(path)
    if (!f || view.status === 'superseded') continue
    const reasons = []
    if (view.status === 'conflicting') reasons.push('contradiction_unresolved')
    if (view.status === 'candidate') reasons.push('awaiting_borrower_confirmation')
    if (view.status === 'needs_clarification') reasons.push('clarification_requested')
    if (view.estimated) reasons.push('value_is_estimated')
    if (f.teamReview) reasons.push('team_verification_required')
    if (view.confidence != null && view.confidence < 0.6) reasons.push('low_interpretation_confidence')

    items.push({
      path,
      label: chipLabel(path, locale),
      section: f.section,
      value: safeDisplay(path, view),
      status: view.status,
      source: view.source,
      // Provenance the team needs: a derived value must never read as borrower-provided.
      borrowerStated: ['borrower_text', 'borrower_voice_transcript', 'borrower_secure_input'].includes(view.source),
      estimated: Boolean(view.estimated),
      confidence: view.confidence,
      secure: Boolean(f.secureEntry),
      confirmedAt: view.confirmed_at,
      conflictValues: state.conflicts[path]?.values || null,
      needsReview: reasons.length > 0,
      reasons,
      // The borrower's own words, for context — already scrubbed of sensitive values upstream.
      originalText: f.secureEntry ? null : view.original_text,
    })
  }

  return {
    percent: report.percent,
    status: report.status,
    meaning: report.meaning,
    notMeaning: report.notMeaning,
    unresolvedRequired: report.openFields.map((o) => ({
      path: o.path, section: o.section, status: o.status, requirement: o.requirement,
    })),
    structural: report.structural,
    conflicts: report.conflicts,
    estimatedValues: items.filter((i) => i.estimated).map((i) => i.path),
    unconfirmedValues: items.filter((i) => i.status === 'candidate').map((i) => i.path),
    needsReview: items.filter((i) => i.needsReview),
    items,
    parties: parties.map((p) => ({
      id: p.id, index: p.party_index, role: p.party_role, name: p.display_name || null,
    })),
  }
}

/** Per-party progress split (§19: borrower and co-borrower progress separately). */
export function partyProgress(report, partyIndex) {
  const prefix = `parties[${partyIndex}].`
  const open = report.openFields.filter((o) => o.path.startsWith(prefix))
  const structural = report.structural.filter((s) => s.partyIndex === partyIndex)
  const conflicts = report.conflicts.filter((c) => c.path.startsWith(prefix))
  return { partyIndex, open: open.length + structural.length, conflicts: conflicts.length }
}

/** Repeated-question / confusion flags the team should see (§19). */
export function confusionFlags(askedHistory, { threshold = 2 } = {}) {
  return Object.entries(askedHistory || {})
    .filter(([, v]) => (v.confused || 0) >= threshold || (v.attempts || 0) > threshold + 1)
    .map(([questionId, v]) => ({
      questionId, attempts: v.attempts || 0, confused: v.confused || 0, skipped: Boolean(v.skipped),
    }))
}

export { isResolved }
