# OURMTG — Phase 1B Architecture

Branch `claude/ourmtg-phase1b-borrower-operations` · base `fd0373f`. Approved stack unchanged
(Vite / React / Netlify / Supabase). Everything new is **pure + flag-gated + draft-only**; no
production DB writes, no migrations applied, no production endpoint rewired, existing behavior preserved.

## Layers added
```
src/domain/
  lifecycles.js        canonical operational vocab + deterministic state machines (single source)
  vocab.js             re-exports EVENT_TYPES + TASK_STATUS from lifecycles (no forked enums)
  flags.js             + Phase 1B flags (all default false)
  cashToClose.js       pure deterministic planning engine
  visibility.js        pure role/visibility predicates for the new domain
  services/
    taskService.js     task state machine + role/AI guards (injected store)
    eventService.js    append-only, idempotent event ledger (injected store)
    disclosureService.js provider-neutral disclosure state model (no e-sign)
    notifications.js   provider-neutral notification event model (no campaign engine)
    aiBoundary.js      AI-may-only-propose contract

src/lib/
  needsAttention.js    borrower action items derived from existing checklist + conditions
  loanTeamOps.js       deterministic blockers + "what changed today"

src/components/  (flag-gated, additive)
  NeedsAttention.jsx · CashToClosePanel.jsx · ThirdPartyPanel.jsx · TeamContactCard.jsx

docs/phase1b/draft-migrations/  OURMTG-1B-operational-schema.DRAFT.sql (10 entities, guarded)
```

## Wiring status
- **Wired to production:** nothing new by default. `BorrowerDashboard` and `LODashboard` gained
  additive sections rendered **only** when their flags are on (`borrowerWorkspaceV2`,
  `cashToClosePlanner`, `thirdPartyTracking`, `loanTeamWorkspaceV2`). The verified team-contact
  card replaces the old team card (same slot, accurate licensing) and is always shown.
- **Flag-gated (default OFF):** task service, event service, disclosure/third-party/notification
  models, AI suggestions, and the enhanced workspaces. Enable per-environment via `VITE_FF_*`
  (client) / `FF_*` (server) for a pilot; production stays on the existing behavior until flipped.
- **Draft-only:** the 10-entity operational schema (organization boundary, tasks, events,
  milestones, cash-to-close, disclosures, third-party) — guarded, non-runnable, outside `supabase/migrations/`.

## Data flow (when enabled, future)
`GRCRM app_state → projector → loan_files` (unchanged) · new operational writes go through the
service layer (service-role, org-scoped, RLS default-deny) which appends immutable `loan_events`
and `loan_task_history`. Borrower exposure stays column-scoped through the gateway; realtor/escrow/
title remain milestone-only. AI participates only as a proposer whose output requires human approval.

## Tenancy direction
The draft schema introduces the mandated explicit `organization_id` on every operational table
(+ `organizations`/`organization_members`). Existing 036–039 tables are unchanged this phase; a
default-organization backfill is required before these drafts become real migrations.

## Non-goals honored
No Next.js/Vercel migration; no Arive/e-sign/appraisal/title/escrow/insurance integration; no active
AI actions; no production tables created; no deploy/merge/migration; no production env change; no UI redesign.
