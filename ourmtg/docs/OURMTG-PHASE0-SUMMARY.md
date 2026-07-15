# OURMTG — Phase 0 Summary (corrected)

**Repo:** `westccmortgage/Ourmtg` · **Branch:** `claude/ourmtg-ai-operations-phase0-rebase` · **Base:** `1a224bf` · **Date:** 2026-07-15

Phase 0 is **audit + reconciliation only**. No production system, database, environment variable, or migration was changed. No Phase 1 work was started. See companion docs:
- `OURMTG-CURRENT-STATE-AUDIT.md` — exhaustive current state (frontend, backend, DB, deploy, risks).
- `OURMTG-TARGET-DATA-MODEL.md` — target schema reconciled against existing tables.
- `OURMTG-IMPLEMENTATION-PLAN.md` — phased plan mapped to what already exists.
- `OURMTG-PHASE1-PROMPT.md` — the exact, corrected Phase 1 prompt.

---

## 1. The one correction that matters

The previous Phase 0 package described a **backend-only project with no frontend, no build, no login, no dashboards, no intake, and nothing deployed.** That is wrong for this repository. This repo is a **working, deployable Vite/React application** (17 pages, magic-link auth, borrower/realtor/LO portals, secure documents) on **18 Netlify Functions** and **12 database tables (migrations 036–039)**, backed by a trilingual public funnel. `npm run check` and `npm run build` both pass on the audit branch.

The old audit's conclusions were correct **as architectural ideas** (product boundaries, loan journey, event/task model, disclosure control, cash-to-close, AI governance, threat model, feature flags, pure domain contracts). They are wrong **as a description of ground truth**. This package keeps the ideas and rewrites the ground truth.

---

## 2. Corrected system-of-record picture

- **GRCRM is the source of truth.** OurMTG reads GRCRM's `app_state` (`wcci-deals`) **read-only** through the projector `sync-loan-file.mjs` (5-min cron) and never writes borrower data back into `app_state`.
- **One shared Supabase project** (GRCRM's). OurMTG adds projection tables (`loan_files`, `loan_documents`, …) that are service-role-written and RLS-read.
- **Magic-link only**, no passwords. External identities (borrower/coborrower/realtor/escrow/title) live in `portal_users`; internal LO/team are `auth.users` with owner/team access resolved in code.
- **WCCI.online** is the AI strategy engine — server-to-server, output stored in `loan_strategy` as `draft`, invisible to borrowers until an LO approves (enforced in RLS: only `status='approved'` is readable).
- **Stack reality:** Vite/React + Netlify Functions (spec §C's Next.js/Vercel recommendation was not the path taken — an owner decision to ratify, not a defect).

---

## 3. Capability map — target system vs. what exists today

Legend: ✅ implemented · 🟡 partial · 🔧 needs extension · ➕ missing · 🔒 leave untouched

| Target capability | Status | Where it lives today / what's needed |
|---|---|---|
| Invitation-only borrower workspace | ✅🔒 | `portal-invite-create/accept` (identity-bound, single-use); `Portal.jsx` dispatcher. Untouched. |
| Borrower tasks (documents) | ✅ | `loan_documents` + `Documents.jsx` + signed-URL upload flow. |
| Team tasks | 🟡 | `portal_team` gives team access; there is **no discrete internal task object** (LO "next action" is *computed* in `portal-review-queue`, not stored). Needs a task model if tasks must be assignable/trackable. |
| Document requests | ✅ | `portal-doc-request` (ad-hoc) + checklist-driven requests. |
| Secure upload | ✅🔒 | Private `ourmtg-docs`, server-controlled paths, signed URLs. Untouched. |
| Document review | ✅ | `portal-doc-review` (race-safe accept/reject + reason). |
| Disclosures tracking (LE/CD, ESIGN) | 🟡➕ | Referenced in copy (`WhoDoesWhat.jsx`, `Legal.jsx`) and consent types (`portal_consent`); **no disclosure delivery/tracking object or e-sign flow.** New. |
| Signatures / e-sign | ➕ | Absent. ESIGN consent conceptually modeled (`portal_consent.consent_type='econsent'`), no signing workflow. New (integration decision needed). |
| Stage & milestone tracking | ✅🔒 | 7-stage pipeline (`pipeline.js` / `STAGE_META`), `StatusTracker.jsx`, realtor milestone view. Untouched. |
| Pre-approval | ✅ | LO-set realtor-visible band (`portal-preapproval-set`); draft letter in `BuildFile.jsx`. |
| Realtor visibility | ✅🔒 | Milestone-only, structurally blocked from financials (RLS + code). Untouched. |
| Appraisal / title / escrow / insurance | 🟡➕ | `escrow`/`title` exist as **milestone-only access roles** (038); **no vendor-order/appraisal/insurance objects or status.** New domain objects. |
| Cash-to-close ledger | 🟡➕ | Present only as a client-side **estimate** (`BuildFile.jsx`, `Calculator.jsx`). **No transactional/actual CTC ledger.** New. |
| Notifications + delivery tracking | 🟡🔧 | Emails send (Resend, fail-soft) but there is **no persisted delivery record**. Extend `mailer.mjs` + add a delivery/event log. SMS (Twilio) not built. |
| AI File Supervisor | 🟡➕ | Schema placeholder `loan_strategy` (draft→approved gate) exists; **no supervisor engine, no next-best-action store, no AI governance object.** New, behind a flag. |
| Event log (immutable) | 🟡➕ | `portal_access_log` (audit) + `loan_messages` (timeline) exist; **no general append-only domain-event stream** (`lead.created`, `deal.stage_changed`, `doc.uploaded`, …) for automations. New. |
| Audit log | ✅ | `portal_access_log` (view/download/upload/login), fail-soft `logAccess`. |
| Arive synchronization | 🟡🔧 | GRCRM's Arive→pipeline sync is upstream; OurMTG consumes it via the `app_state` projector. Direct Arive integration is out of OurMTG's boundary (GRCRM owns it). |

**Rule:** nothing marked ✅/🔒 is to be rebuilt. New work targets ➕ and 🔧 items, additively, behind default-off flags.

---

## 4. Existing capabilities the previous audit missed

Full public funnel (Home/Apply/6 lead flows/calculators/`/plan`/`/who`, trilingual EN·ES·RU); magic-link auth + role chooser; borrower dashboard; end-to-end secure documents; realtor portal (QR + co-branded link); LO command center + file detail; standalone manual-file mode; team access; escrow/title roles; owner-editable site settings; written consent ledger; the `app_state` projector; installable PWA. (Detail in `OURMTG-CURRENT-STATE-AUDIT.md` §7.)

---

## 5. Corrected risk summary (top items)

1. **R1 — Global `site_settings` writable by any authed user** (owns-≥1-file authz + self-provisioned ownership). Restrict to `OURMTG_ADMIN_EMAILS`. **High.**
2. **R2 — cronGuard header trust** on `sync-loan-file`. Harden with `CRON_SECRET`. Medium.
3. **R3 — No rate limiting on public `lead-submit`.** Medium.
4. **R5 — No tests/CI/lint; no email delivery tracking.** Medium.
5. **R6 — Runbook drift:** migration 039 + `cron_heartbeat` not reflected in `OURMTG_DEPLOY.md`. Medium.
6. **R4 — Stale "OWNER only" comments** vs `isInternal` code. Low.
7. **R8 — Stack ≠ spec** (Vite/Netlify vs Next/Vercel). Owner decision.

Security posture is otherwise strong (see audit §6).

---

## 6. Deliverables in this Phase 0 package

- Rewritten docs (this file + audit + target model + implementation plan + Phase 1 prompt).
- **Pure domain scaffolding** under `ourmtg/src/domain/` — feature flags (all **default off**), event/task contracts, capability enums that **re-use** existing vocabularies (no duplicate stage/status enums). Not wired into production. Placement rationale in `ourmtg/src/domain/README.md`.
- **Non-runnable draft migrations** under `ourmtg/docs/phase0/draft-migrations/` — clearly marked DO-NOT-APPLY, mapped to existing tables, never uncommented into the numbered migration sequence.
- **Contract tests** for the domain scaffolding (`node:test`, zero new dependencies) — pure, no production behavior changed.

---

## 7. Unresolved owner decisions (carry into Phase 1)

1. **Ratify the stack:** stay on Vite/React + Netlify (recommended — it works and is deployed) or migrate toward the spec's Next.js/Vercel? Phase 1 assumes **stay**.
2. **Fix R1** now (restrict site-settings to admin emails)? Recommended yes.
3. **Task model:** do internal team tasks need to be first-class stored objects, or is the computed "next action" sufficient for now?
4. **Signatures/e-sign & disclosures:** build in-house or integrate a vendor (DocuSign/Dropbox Sign/etc.)? Affects the target data model.
5. **SMS (Twilio):** platform-level sender or per-broker credentials (reuse GRCRM's)?
6. **AI File Supervisor** scope for Phase 1: read-only "stuck/next-best-action" surfacing vs. drafting borrower-facing content (the latter needs the WCCI review gate).
7. **Multi-tenancy:** confirm `owner_user_id` remains the only tenant boundary (no `org_id`) — matters if brokerages/teams beyond one owner are expected.
8. **`cron_heartbeat`** — confirm it exists in the shared Supabase project or add a creating migration.
