// SCHEDULED (cron): OurMTG loan-file PROJECTOR.
//
// Reconciles the borrower-facing PROJECTION (public.loan_files) from GRCRM's system
// of record (app_state key 'wcci-deals'). GRCRM stays the source of truth; this
// function only ever WRITES loan_files. Portal users read loan_files via RLS
// (migration 036) — they can never touch app_state.
//
// WHY A RECONCILER (mirrors cron-automations' design):
//   • Runs server-side on a schedule → survives closed tabs / multi-device edits.
//   • Fully IDEMPOTENT: upsert on (owner_user_id, source_deal_id). Two consecutive
//     runs converge to the same rows; nothing double-writes.
//   • The Arive (LOS) → deal.stage sync already lands in wcci-deals, so a loan's
//     stage change flows: Arive → wcci-deals → (this) → loan_files → borrower portal.
//
// WHAT IT PROJECTS:
//   Only MORTGAGE deals — a deal whose stage is one of the pipeline stages
//   (lead/preapproval/processing/underwriting/conditional/ctc/funded). Generic-CRM
//   deals (new/contacted/qualified/…) are skipped, so non-mortgage users are ignored.
//   A deal with no borrower identity at all is skipped.
//
// WHAT IT NEVER TOUCHES:
//   preapproval_amount / preapproval_expires — these are LO-controlled, Realtor-
//   visible fields set via the portal admin. Omitting them from the upsert payload
//   means ON CONFLICT DO UPDATE leaves the existing values intact (and they default
//   to NULL on first insert). This keeps borrower/Realtor exposure under human control.
//
// INVOCATION:
//   • Netlify scheduler (every 5 min) — verified via cronGuard.isScheduledInvocation.
//   • Manual/test: POST with header x-cron-secret: <CRON_SECRET>.
//   The work is light (DB read + batched upserts, no external sends), so it runs
//   INLINE and time-boxed — no background dispatch needed. Deferred owners resume
//   next tick (idempotent).
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE, CRON_SECRET (for manual trigger).

import { admin, isConfigured } from './_lib/supabase.mjs'
import { isScheduledInvocation, rejectionLog, heartbeat } from './_lib/cronGuard.mjs'

export const config = { schedule: '*/5 * * * *' } // every 5 minutes (UTC)

// The mortgage pipeline stage keys (must match src/lib/pipeline.js STAGES). A deal
// whose stage isn't one of these is a generic-CRM deal → not projected.
const MORTGAGE_STAGES = new Set([
  'lead', 'preapproval', 'processing', 'underwriting', 'conditional', 'ctc', 'funded',
])

// ── field helpers ─────────────────────────────────────────────────────────────

const str = (v) => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

// Accept 'YYYY-MM-DD' (the app's <input type=date> shape); anything else → null so
// a malformed value never breaks the whole owner's projection.
const isoDate = (v) => {
  const s = str(v)
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`
}

// Map one GRCRM deal → a loan_files row payload (owner scoping applied by caller).
// Returns null for deals that shouldn't be projected (non-mortgage / no identity).
export function projectDeal(ownerUserId, deal) {
  if (!deal || typeof deal !== 'object' || !deal.id) return null

  const stage = str(deal.stage)
  if (!stage || !MORTGAGE_STAGES.has(stage)) return null // generic-CRM deal → skip

  const borrowerName = str(deal.contactName) || str(deal.borrower)
  const email = str(deal.contactEmail)
  const phone = str(deal.contactPhone)
  // Need at least one borrower identifier, else there's nothing a portal could show.
  if (!borrowerName && !email && !phone) return null

  return {
    owner_user_id: ownerUserId,
    source_deal_id: String(deal.id),
    loan_number: str(deal.externalId) || str(deal.loanNumber),
    borrower_name: borrowerName,
    // Partner/Realtor reference kept as text (deal.partnerContactId when linked,
    // else the referredBy label). MVP: opaque reference, resolved later in the portal.
    realtor_contact_id: str(deal.partnerContactId) || str(deal.referredBy),
    loan_type: str(deal.type),
    purpose: str(deal.purpose),
    stage,
    amount: num(deal.amount),
    est_close_date: isoDate(deal.closeDate),
    // NOTE: preapproval_amount / preapproval_expires deliberately omitted — see header.
  }
}

// ── main reconcile pass ───────────────────────────────────────────────────────
// Loads every owner's wcci-deals, projects mortgage deals, and upserts loan_files
// in one batched write per owner. Time-boxed; returns a small summary.
export async function runProjection(db, { timeBudgetMs = 18000 } = {}) {
  const runStart = Date.now()
  const outOfBudget = () => (Date.now() - runStart) > timeBudgetMs

  const { data: dealRows, error: dErr } = await db
    .from('app_state')
    .select('user_id, doc')
    .eq('key', 'wcci-deals')

  if (dErr) {
    console.error('[sync-loan-file] failed to load deals:', dErr.message)
    return { ok: false, error: 'Query failed', owners: 0, projected: 0, errors: 1, deferred: false }
  }

  let owners = 0, projected = 0, errors = 0, deferred = false

  for (const row of dealRows || []) {
    if (outOfBudget()) {
      console.warn('[sync-loan-file] time budget reached, deferring remaining owners')
      deferred = true
      break
    }

    const ownerUserId = row.user_id
    const deals = Array.isArray(row.doc) ? row.doc : []
    if (deals.length === 0) continue

    // Build the projection payloads for this owner. Dedupe by source_deal_id so a
    // malformed duplicate id in the doc can't cause an ON CONFLICT self-collision
    // within a single upsert batch (Postgres rejects that with error 21000).
    const bySource = new Map()
    for (const deal of deals) {
      const payload = projectDeal(ownerUserId, deal)
      if (payload) bySource.set(payload.source_deal_id, payload)
    }
    const payloads = [...bySource.values()]
    if (payloads.length === 0) continue

    try {
      const { error: wErr } = await db
        .from('loan_files')
        .upsert(payloads, { onConflict: 'owner_user_id,source_deal_id' })
      if (wErr) throw new Error(wErr.message)
      owners++
      projected += payloads.length
    } catch (e) {
      errors++
      console.error(`[sync-loan-file] owner ${ownerUserId} upsert failed:`, String(e?.message || e))
    }
  }

  return { ok: true, owners, projected, errors, deferred }
}

export default async (req) => {
  if (!isScheduledInvocation(req)) {
    rejectionLog(req, 'sync-loan-file')
    return new Response('Forbidden', { status: 403 })
  }
  if (!isConfigured()) {
    console.log('[sync-loan-file] Supabase not configured — skipping')
    return new Response('Not configured', { status: 200 })
  }

  const db = admin()
  await heartbeat(db, 'sync-loan-file')

  const result = await runProjection(db, { timeBudgetMs: 18000 })
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  })
}
