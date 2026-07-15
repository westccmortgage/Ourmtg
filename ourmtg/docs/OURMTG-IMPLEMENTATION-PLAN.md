# OURMTG — Implementation Plan (reconciled against the real app)

**Repo:** `westccmortgage/Ourmtg` · **Branch:** `claude/ourmtg-ai-operations-phase0-rebase` · **Base:** `1a224bf`

This plan **extends a working application**. It does not rebuild the funnel, auth, dashboards, documents, or pipeline that already ship. Every phase is additive, behind default-off feature flags (`ourmtg/src/domain/flags.js`), and preserves the load-bearing rules in `OURMTG_HANDOFF.md`.

Sequencing principle: **fix the sharp edges first (cheap, high-value), then add new domain objects, then AI.** Do not start any of this in Phase 0.

---

## Phase 1 — Harden what exists (no new domain tables)

Goal: close the audit's real gaps without new schema. Small, verifiable, reversible.

1. **R1 — restrict `site_settings` writes.** Change `portal-settings-set` authz to `OURMTG_ADMIN_EMAILS` only (drop the "owns ≥1 file" path). Verify a non-admin owner gets 403; admin still writes. *(Files: `netlify/functions/portal-settings-set.mjs`.)*
2. **R2 — harden the cron.** Require `CRON_SECRET` in addition to the Netlify header for `sync-loan-file` (keep scheduled invocation working). *(Files: `_lib/cronGuard.mjs`, `sync-loan-file.mjs`.)*
3. **R3 — rate-limit `lead-submit`.** Per-IP throttle (e.g. token bucket in a lightweight table or edge). Keep it public and fail-open on limiter error, fail-closed on abuse. *(Files: `netlify/functions/lead-submit.mjs`.)*
4. **R4 — fix stale comments** ("OWNER only" → "owner or team via `isInternal`") in `portal-invite-create`, `portal-preapproval-set`.
5. **R6 — runbook truth.** Add migration 039 to `OURMTG_DEPLOY.md`; confirm/repair `cron_heartbeat` existence in the shared project (add a creating migration if absent).
6. **R5 (start) — CI + contract tests.** Wire `npm run check` + `npm run build` into CI; add the Phase 0 domain contract tests to the pipeline. Add a `test` script (`node --test`). No new runtime deps.

**Exit criteria:** all six items done; `check` + `build` + contract tests green in CI; no schema change; no behavior change for legitimate users.

---

## Phase 2 — Event stream + delivery tracking (foundational new schema)

Goal: give automations and the AI supervisor something to stand on, and make notifications observable.

1. Apply **`loan_events`** (draft B1) — immutable, idempotent domain-event stream. Emit from the projector and gateway write paths (`doc.uploaded`, `deal.stage_changed:*`, `condition.cleared`, `lead.created`) — additively, behind `flags.eventStream`.
2. Apply **`notification_deliveries`** (draft B3). Extend `_lib/mailer.mjs` to record every send (`queued/sent/failed/skipped`) with an idempotency key. Surface delivery state in `LoanFileDetail.jsx` (LO only).
3. Wire the **24h/72h missing-doc reminders** (spec §J rules 5–8) using `loan_documents.status/requested_at` + `loan_events`, armed and DNC-safe (reuse GRCRM's `cron-automations` where possible).

**Exit criteria:** events recorded idempotently; a sent email produces exactly one delivery row; reminders fire once per rule per 24h; existing flows unchanged with the flag off.

---

## Phase 3 — Task model + vendor/CTC objects (owner-gated)

Only build the pieces the owner confirms (decisions #3–#4 in the summary).

1. **`loan_tasks`** (draft B2) — if stored/assignable tasks are wanted. Replace the *computed* review-queue "next action" surface progressively; keep `loan_conditions` separate.
2. **`loan_vendor_orders`** (draft B4) — appraisal/title/escrow/insurance status; milestone-only exposure through the gateway.
3. **`loan_cash_to_close`** (draft B5) — actual CTC ledger (borrower/coborrower only), distinct from the client-side estimate.
4. **Disclosures / e-sign** (draft B6) — only after the vendor-vs-in-house decision. Do not conflate with `loan_documents`.

**Exit criteria:** each new object RLS default-deny + SELECT-only; realtor structural block intact; borrower exposure column-scoped through the gateway; flags default off until each surface is complete.

---

## Phase 4 — AI File Supervisor (governed)

1. Reuse **`loan_strategy`** for AI content; keep the `draft→approved→hidden` RLS gate (borrowers never see unapproved output).
2. Emit supervisor findings as `loan_events` (`ai.flag`, `ai.next_best_action`) for the LO queue; no borrower-facing AI text without LO approval.
3. WCCI called **server-to-server only**, non-PII loan shape (spec §I.2). No rates/approval/DPA-fact claims (spec §M). Behind `flags.aiSupervisor`, off by default.

**Exit criteria:** no unapproved AI text reachable by any borrower path (verified against the RLS gate + gateway); WCCI never called from the browser; governance banned-phrase checks pass.

---

## Cross-cutting rules (every phase)

- **Preserve** GRCRM-as-truth, no `app_state` writes, realtor/escrow/title financial blocks (RLS + code), private-bucket-only docs, human-only pre-approval exposure, secrets server-side.
- **Reuse** authz primitives (`resolveAccess`/`isInternal`/`canSeeFinancials`) on every new endpoint.
- **Reuse** vocabularies (stages, doc/condition/strategy status). No duplicate enums, no second stage/task model.
- **Additive + reversible:** new tables only, flags default off, drafts carry rollback.
- **Verify each change** by exercising the real flow (magic-link → dashboard → the changed surface), not only tests. Add contract tests where pure.

---

## Explicitly deferred / out (unchanged from spec §O + roadmap)

New CRM; second database; marketing site; passwords; public doc storage; client-side WCCI; AI that quotes rates or promises approval; retroactive automation blasts; native mobile apps; full OCR pipeline. SMS (Twilio) remains designed-not-built until a sender decision (owner #5).
