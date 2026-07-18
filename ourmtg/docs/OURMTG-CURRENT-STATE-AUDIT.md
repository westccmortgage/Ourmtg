# OURMTG — Current-State Audit (Phase 0, corrected)

**Repository:** `westccmortgage/Ourmtg`
**Branch of this audit:** `claude/ourmtg-ai-operations-phase0-rebase`
**Base commit:** `1a224bf14315a67fdecf6e66e1ff69671242739c` ("Trilingual public funnel: English, Spanish, Russian")
**Audit date:** 2026-07-15
**Method:** Full read of every source file under `ourmtg/` (frontend, functions, migrations, docs) + `npm run check` + `npm run build`. No production system, database, or environment was touched.

---

## 0. Why this document exists (read this first)

A previous "Phase 0" package was produced from a **backend-only scratchpad inside a GRCRM-scoped session**. It is **not** an accurate description of this repository. This document replaces it as ground truth.

**Claims from the previous audit that are FALSE for this repository — discard them:**

| Prior claim | Reality in this repo | Evidence |
|---|---|---|
| "No frontend" | Full Vite/React SPA, 17 pages, React Router v6 | `ourmtg/src/App.jsx`, `ourmtg/src/pages/*` |
| "No build" | `vite build` succeeds (185 modules, ~554 kB bundle) | `ourmtg/package.json` `build`, verified below |
| "No login UI" | Supabase magic-link login page | `ourmtg/src/pages/Login.jsx`, `ourmtg/src/lib/auth.jsx` |
| "No borrower dashboard" | Borrower dashboard with status, docs, conditions, messages | `ourmtg/src/pages/BorrowerDashboard.jsx` |
| "No loan-team dashboard" | LO/team command center + per-file drill-in | `ourmtg/src/pages/LODashboard.jsx`, `LoanFileDetail.jsx` |
| "No application intake" | Public borrower intake + 6 lead flows + calculators | `ourmtg/src/pages/Apply.jsx`, `LeadFlow.jsx`, `Calculator.jsx`, `BuildFile.jsx` |
| "No deployed application" | Netlify-deployable SPA + 18 Functions; deploy runbook exists | `netlify.toml`, `ourmtg/docs/OURMTG_DEPLOY.md` |

The prior audit also knew only about migrations **036 and 037**. This repo contains **036, 037, 038, and 039**.

> The intentional `ourmtg/` subdirectory is **not** a nesting bug. The root `netlify.toml` sets `base = "ourmtg"` on purpose (monorepo pattern). Do not "flatten" it.

---

## 1. Repository shape & deployment

```
/ (repo root)
├── netlify.toml            # base = "ourmtg"; SPA redirect; secrets-scan omit keys
├── .gitignore
└── ourmtg/                 # the application (Netlify build base)
    ├── package.json        # scripts: dev, build, preview, check
    ├── vite.config.js      # React SPA, outDir dist
    ├── index.html
    ├── .env.example        # documents every env var (client + server)
    ├── public/             # icon.svg, manifest.webmanifest (installable PWA)
    ├── src/                # React SPA (see §2)
    ├── netlify/functions/  # 18 handlers + 6 shared libs (see §3)
    ├── supabase/migrations/# 036–039 (see §4)
    └── docs/               # SPEC, ROADMAP, HANDOFF, GATEWAY, DEPLOY (+ this Phase 0 set)
```

**`netlify.toml` (root)** — `ourmtg/netlify.toml` does not exist; the single source of truth is the root file:
- `[build] base = "ourmtg"`, `command = "npm run build"`, `publish = "dist"` (→ `ourmtg/dist`), `functions = "netlify/functions"` (→ `ourmtg/netlify/functions`).
- `SECRETS_SCAN_OMIT_KEYS = "SUPABASE_URL,SUPABASE_ANON_KEY,VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY"` — these are public by design. `SUPABASE_SERVICE_ROLE` is deliberately **not** omitted (the scanner must keep protecting it).
- SPA history fallback: `/* → /index.html` (200). Netlify resolves `/.netlify/functions/*` and static assets before this catch-all.

**Stack divergence worth flagging (owner decision):** `docs/OURMTG_SPEC.md` §C recommends **Next.js on Vercel**. The **actual** implementation is **Vite/React on Netlify**. Every capability below is real; only the framework/host differ from the spec's stated recommendation. The Phase 1 plan is written against the *actual* stack (Vite/React + Netlify Functions), not the spec's aspiration.

---

## 2. Frontend (Vite/React SPA)

Entry: `ourmtg/src/main.jsx` → `ourmtg/src/App.jsx`. Providers wrap the tree in order: `<LangProvider>` (i18n) → `<AuthProvider>` (Supabase session) → `<BrowserRouter>`. Every route renders inside `<Layout>` (`ourmtg/src/components/Layout.jsx`: top bar + compliance footer).

### 2.1 Routes (from `ourmtg/src/App.jsx`)

| Path | Component (file) | Access | Purpose |
|---|---|---|---|
| `/` | `pages/Home.jsx` | Public | Two-button front door; owner-editable hero |
| `/login` | `pages/Login.jsx` | Public | Magic-link sign-in (no password) |
| `/apply` | `pages/Apply.jsx` | Public | Borrower intake → `lead-submit` |
| `/realtor` | `pages/RealtorLanding.jsx` | Public | Realtor front door + submit-a-buyer |
| `/calculator` | `pages/Calculator.jsx` | Public | Affordability + refi calculators |
| `/plan` | `pages/BuildFile.jsx` | Public | "Моё Дело №" file builder + draft pre-approval letter |
| `/who` | `pages/WhoDoesWhat.jsx` | Public | Transaction-cast explainer + wire-fraud warning |
| `/dpa /fha /va /self-employed /jumbo /refi` | `pages/LeadFlow.jsx` (`FLOWS`) | Public | 6 program lead flows |
| `/invite` | `pages/Invite.jsx` | Public route, requires sign-in | Redeem invite token → `portal-invite-accept` |
| `/legal/:doc` | `pages/Legal.jsx` | Public | Privacy / Terms (placeholder copy) |
| `/portal` | `pages/Portal.jsx` | **Protected** | Role dispatcher (see §2.3) |
| `/portal/documents/:loanFileId` | `pages/Documents.jsx` | **Protected** | Borrower doc checklist + secure upload |
| `/portal/file/:loanFileId` | `pages/LoanFileDetail.jsx` | **Protected** | LO per-file drill-in |
| `/portal/new-file` | `pages/NewLoanFile.jsx` | **Protected** | Manual loan-file creation (standalone mode) |
| `*` | `NotFound` (inline in `App.jsx`) | — | 404 |

Protected routes are wrapped by `ourmtg/src/components/RequireAuth.jsx` (spinner while the session resolves, redirect to `/login` preserving `from`).

`pages/RealtorPortal.jsx`, `pages/BorrowerDashboard.jsx`, `pages/LODashboard.jsx` are **not** routed directly — `pages/Portal.jsx` renders them based on detected role.

### 2.2 Authentication (`ourmtg/src/lib/auth.jsx`)

- **Magic-link / OTP only, no passwords** (`signInWithOtp`). Session from `supabase().auth.getSession()` + `onAuthStateChange`.
- Client Supabase config: `ourmtg/src/lib/config.js` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `API_BASE` default `/.netlify/functions`, `BRAND`). Everything client-side is public by design.
- All authenticated API calls forward the Supabase JWT as `Authorization: Bearer` via `ourmtg/src/lib/api.js` (`authHeader()`).

### 2.3 Roles (`ourmtg/src/lib/useRole.js` + `pages/Portal.jsx`)

There is **no server "who am I" endpoint**. Roles are inferred client-side:
- `listMyGrants()` reads `portal_access` directly (RLS-readable own-grants) → visibility values.
- `getReviewQueue()` returns owned/team files → presence implies **LO/owner**.

Role mapping:
- `visibility ∈ {borrower, coborrower}` → **borrower** role → `BorrowerDashboard`.
- `visibility ∈ {realtor, escrow, title}` → **realtor/partner** role → `RealtorPortal` (milestone-only).
- non-empty review queue → **lo** role → `LODashboard`.
- **Empty role** → role chooser (never a dead end): buying/refi → `/plan`; invited → paste-invite fallback (extracts 32-hex token); realtor → `/realtor`; LO/team → `/portal/new-file`.
- Multiple roles → `?as=` view switcher.

### 2.4 Document UI

- **Borrower upload:** `pages/Documents.jsx` — renders gateway checklist (`getChecklist`), per-item camera/file upload (`accept="image/*,application/pdf"`, 25 MB cap) via `uploadDocument()` (signed URL → private bucket → `completeUpload`). Borrower vs co-borrower grouping. Rejection shows reason.
- **Borrower summary:** `BorrowerDashboard.jsx` — "X of Y uploaded" link-card.
- **LO review/request:** `LoanFileDetail.jsx` — DocRow (View via 300 s signed URL, Accept, Reject-with-reason) + `RequestDocForm` (ad-hoc requests).
- Status vocabulary (`components/ui.jsx` `StatusChip`): `missing→"Not started"`, `requested→"Requested"`, `uploaded→"Under review"`, `accepted→"Accepted"`, `rejected→"Needs another"`, `open→"Action needed"`, `submitted→"Under review"`, `cleared→"Cleared"`.

### 2.5 Stage / milestone tracking

`ourmtg/src/lib/pipeline.js` mirrors the server's `STAGE_META`. **7 stages** (authoritative order):
`lead → preapproval → processing → underwriting → conditional → ctc → funded`
Labels: Application, Pre-Approval, Processing, Underwriting, Conditional, Clear to Close, Funded. Realtors see coarse `MILESTONE_LABEL` only. Rendered by `components/StatusTracker.jsx`.

### 2.6 Localization & responsive

- **Trilingual EN / ES / RU** across the **public funnel** (`ourmtg/src/lib/i18n.jsx`: `useT` for chrome strings, `usePick`/`pickLang` for inline `{en,es,ru}` marketing content). Auto-detected from `navigator.language`, persisted to `localStorage` (`ourmtg_lang`), applied to `<html lang>`. Switcher in the top bar.
- **Authenticated portal pages are English-only** (dashboards, Documents, LoanFileDetail, NewLoanFile do not use `useT`/`usePick`). Consent disclosure is stored canonically in English regardless of display language.
- Mobile-first markup: `inputMode`, `type=tel/email`, camera uploads, single-column max-width containers, horizontally-scrolling tables (`tablewrap`). CSS in `ourmtg/src/styles.css` (stage colors as CSS vars `--st-*`).

### 2.7 Frontend libs

`api.js` (gateway wrappers + direct RLS reads `listMyGrants`/`listConditions`/`listMessages` + `uploadDocument` + `submitLead`), `config.js`, `auth.jsx`, `useRole.js`, `pipeline.js`, `format.js` (money/date), `i18n.jsx`, `leadFlows.js` (payload shapes + `FLOWS` + `LOAN_TYPES`/`PURPOSES`/`SMS_CONSENT`), `useSettings.js` (reads `site_settings`), `supabase.js`.

---

## 3. Backend (Netlify Functions)

All handlers use the **service-role** Supabase client (`_lib/supabase.mjs admin()`) for DB/storage work and enforce authorization **in code**. RLS is defense-in-depth for direct client reads, not the primary gate for these functions. The anon client (`_lib/userauth.mjs`) is used **only to verify the caller JWT** (`auth.getUser`).

### 3.1 Shared libs (`ourmtg/netlify/functions/_lib/`)

| File | Exports / role |
|---|---|
| `supabase.mjs` | `admin()` service-role client (RLS-bypassing), `isConfigured()`. Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`. |
| `userauth.mjs` | `getUser(req)` verifies Bearer JWT via anon key (`VITE_SUPABASE_ANON_KEY`/`SUPABASE_ANON_KEY`). `userClient(token)` exists but is **unused**. |
| `portal.mjs` | Core authz: `resolveAccess` (owner / team / portal grant → `{role,visibility}`), `isInternal`, `canSeeFinancials`, `borrowerEmails`, `logAccess` (writes `portal_access_log`, fail-soft), `STAGE_META`/`STAGE_STEPS`/`stageInfo`, `randomToken`, CORS/json helpers. |
| `mailer.mjs` | Resend SMTP (`RESEND_PLATFORM_KEY`), **fail-soft** (never throws, no delivery persistence), `esc()` HTML-escaping, `brandedEmail`. |
| `cronGuard.mjs` | `isScheduledInvocation` (trusts `x-netlify-event` header OR `CRON_SECRET`), `heartbeat` (writes `cron_heartbeat`), `rejectionLog`. |
| `checklist.mjs` | Pure: `checklistFor({loanType,purpose})`, `isValidDocKey`, `labelForDocKey`. Borrower-facing `label`/`why` + LO-only `internal` note. No DB/auth. |

### 3.2 Function handlers (`ourmtg/netlify/functions/`)

| Function | Method | Auth | Authorization | Notes |
|---|---|---|---|---|
| `lead-submit.mjs` | POST | **none (public)** | none | Proxies lead to GRCRM `LEAD_INBOUND_URL` with server-side `LEAD_INBOUND_TOKEN`; writes `portal_consent`. No rate limiting. |
| `portal-invite-create.mjs` | POST | JWT | `isInternal` (owner/team) | Mints `portal_invites` (32-hex, 1–60 day). Roles: borrower/coborrower/realtor/escrow/title. |
| `portal-invite-accept.mjs` | POST | JWT | token valid+unused+unexpired + **identity binding** (verified email/phone must match invite) | Single-use; upserts `portal_users`+`portal_access`. |
| `portal-status.mjs` | GET | JWT | any grant | Realtor gets **milestone-only** (no amount/rate/docs); borrower/owner get full safe view. Reads `loan_files`. |
| `portal-checklist.mjs` | GET | JWT | `canSeeFinancials` (realtor 403) | Internal note attached only for `isInternal`. |
| `portal-doc-upload-url.mjs` | POST | JWT | `canSeeFinancials` (realtor 403) | Signed **upload** URL, **server-controlled path** `<owner>/<file>/<docKey>-<rand>` in private `ourmtg-docs`. |
| `portal-doc-complete.mjs` | POST | JWT | `canSeeFinancials` | Verifies object exists before flipping `uploaded`; emails LO + borrower. |
| `portal-doc-review.mjs` | POST | JWT | `isInternal` | Race-safe guarded update (`WHERE status='uploaded'`); reject requires reason; borrower emailed on reject only. |
| `portal-doc-request.mjs` | POST | JWT | `isInternal` | Ad-hoc doc with server-generated `custom_<hex>` key. |
| `portal-condition-set.mjs` | POST | JWT | `isInternal` | Create/update `loan_conditions`; update scoped by id **and** file. |
| `portal-preapproval-set.mjs` | POST | JWT | `isInternal` | **Only** writer of `loan_files.preapproval_*`; emails realtors. Projector never touches these. |
| `portal-message-send.mjs` | POST | JWT | internal OR `canSeeFinancials` (realtor/escrow/title rejected) | Two-way messaging; 4000-char cap. |
| `portal-loanfile-set.mjs` | POST | JWT | create: any authed user; update: `isInternal` | Standalone-mode manual file. `source_deal_id = manual_<hex>`. |
| `portal-review-queue.mjs` | GET | JWT | owner + teams caller belongs to | LO dashboard data (missing/pending/conditions/stuck/nextAction). |
| `portal-file-detail.mjs` | GET | JWT | `isInternal` | Signed **download** URLs (300 s) for uploaded/accepted docs. |
| `portal-team-set.mjs` | GET/POST | JWT | **owner-only** | Add/remove processor/assistant; target must already have a verified auth account. |
| `portal-settings-set.mjs` | POST | JWT | `OURMTG_ADMIN_EMAILS` **OR** owns ≥1 loan file | Writes the global `site_settings` row. **See risk R1.** |
| `sync-loan-file.mjs` | scheduled `*/5 * * * *` (or POST + `CRON_SECRET`) | cron guard | system | Projects GRCRM `app_state` (`wcci-deals`) → `loan_files` (idempotent upsert). Only reader of `app_state`. Never writes `preapproval_*`. Writes `cron_heartbeat`. |

### 3.3 Storage

Single bucket **`ourmtg-docs`, private** (`public=false`, migration 036). Uploads via server-minted signed URLs with server-controlled paths; downloads via 300 s signed URLs, owner/team only, only for `uploaded`/`accepted` docs. Public `crm-media` bucket is explicitly never used for financial docs.

### 3.4 Email / notifications

All via `_lib/mailer.mjs` (Resend SMTP). **Fail-soft**: failures only `console.warn`; **no persistent delivery tracking** exists. Audit trail is `portal_access_log`; consent in `portal_consent`.

---

## 4. Database (migrations 036–039)

`ourmtg/supabase/migrations/` — applied manually in the shared GRCRM Supabase SQL editor (idempotent). **All writes are service-role; every table's RLS exposes SELECT only** (no INSERT/UPDATE/DELETE policies for the authenticated role).

### 4.1 Tables (12)

| Table | Migration | Key columns | FKs (ON DELETE) | RLS SELECT policy |
|---|---|---|---|---|
| `loan_files` | 036 | `owner_user_id`, `source_deal_id`, `stage='lead'`, `amount`, `est_close_date`, `preapproval_amount/expires` | `owner_user_id`→auth.users (**CASCADE**) | **RLS enabled, NO select policy** → gateway-only reads |
| `portal_users` | 036 (role altered 038) | `id`=auth uid, `role` | `id`→auth.users (CASCADE) | `auth.uid()=id` |
| `portal_access` | 036 (altered 038) | `portal_user`, `loan_file_id`, `visibility='borrower'` | both CASCADE | `auth.uid()=portal_user` |
| `loan_documents` | 036 | `doc_key`, `label`, `who`, `status='requested'`, `storage_path` | file CASCADE, owner CASCADE | grant where `visibility∈(borrower,coborrower)` |
| `loan_conditions` | 036 | `title`, `detail`, `status='open'` | file CASCADE, owner CASCADE | grant where `visibility∈(borrower,coborrower)` |
| `loan_messages` | 036 (policy tightened 038) | `direction`, `author_role`, `body`, `channel='portal'` | file CASCADE, owner CASCADE | **038:** grant where `visibility∈(borrower,coborrower)` |
| `portal_consent` | 036 | `consent_type`, `granted`, `ip`, `user_agent`, `text_shown` | `portal_user`/`loan_file_id` → **SET NULL** | `auth.uid()=portal_user` |
| `portal_access_log` | 036 | `action`, `target`, `ip` | both **SET NULL** | `auth.uid()=portal_user` |
| `loan_strategy` | 036 | `source='wcci'`, `payload` jsonb, `summary`, `status='draft'` | file CASCADE, owner CASCADE | `status='approved'` AND grant `visibility∈(borrower,coborrower)` |
| `portal_invites` | 037 (roles altered 038) | `token` UNIQUE 32-hex, `role`, `expires_at`, `accepted_at/by` | file/owner CASCADE; accepted_by/created_by SET NULL | `auth.uid()=owner_user_id` |
| `portal_team` | 038 | `owner_user_id`, `member_user_id`, `role='processor'` | both CASCADE | member OR owner |
| `site_settings` | 039 | `id='default'` singleton, `data` jsonb | — | **public read (`using(true)`)** |

### 4.2 Controlled vocabularies (all `text` + CHECK; no Postgres enums)

- `portal_users.role` / `portal_access.visibility` / `portal_invites.role` — `borrower, coborrower, realtor` **+ `escrow, title` (added 038)**.
- `loan_documents.who` — `borrower, coborrower`.
- `loan_documents.status` — `requested, uploaded, accepted, rejected`.
- `loan_conditions.status` — `open, submitted, cleared`.
- `loan_messages.direction` — `in, out`.
- `loan_strategy.status` — `draft, approved, hidden`.
- `portal_team.role` — `processor, assistant`.
- **NOT constrained (comment-documented only):** `loan_files.stage` (7 stages), `loan_files.loan_type`, `loan_files.purpose`, `loan_messages.author_role`/`channel`, `loan_documents.doc_key`, `portal_consent.consent_type`, `portal_access_log.action`.

### 4.3 Triggers / immutability / tenancy

- `set_updated_at()` trigger on `loan_files`, `loan_conditions`, `loan_strategy` (BEFORE UPDATE).
- **No hard append-only enforcement.** `portal_consent` / `portal_access_log` immutability is by convention (SELECT-only RLS + service-role-only writes). Their FKs use **SET NULL** so audit rows survive deletion.
- **No `org_id`/`tenant_id` anywhere.** Tenancy = `owner_user_id` (the broker's GRCRM auth user). Dedup key `loan_files (owner_user_id, source_deal_id)`. Team access widens the boundary in application code (`resolveAccess`), not SQL.

### 4.4 External (GRCRM) dependencies — referenced, not created here

`auth.users`, `storage.buckets`/`storage.objects`, `set_updated_at()` (originally in GRCRM `schema.sql`), and conceptually GRCRM's `app_state` (`wcci-deals`) read by the projector, and the public `crm-media` bucket (never used). `cron_heartbeat` is written by the cron guard but not created in 036–039 (assumed to exist in the shared project or created elsewhere — **flag for verification**).

---

## 5. Deployment

Per `ourmtg/docs/OURMTG_DEPLOY.md`:
- Netlify builds from `base = "ourmtg"`; do **not** set Base/Build/Publish in the Netlify UI.
- Migrations applied manually in the shared Supabase SQL editor (036, 037, 038 listed; **039 is not yet in the runbook — see R6**).
- Supabase Auth: email magic link enabled; Site URL `https://ourmtg.com`, redirect URLs `https://ourmtg.com/**` (+ preview host).
- Env vars: `VITE_SUPABASE_URL/ANON_KEY` (build-time public), `SUPABASE_URL/ANON_KEY/SERVICE_ROLE` (server), `OURMTG_URL`, `LEAD_INBOUND_URL/TOKEN`, `RESEND_PLATFORM_KEY`, `CRON_SECRET`, `OURMTG_ADMIN_EMAILS`, `MAIL_FROM`.

**QA results (this audit, on branch `claude/ourmtg-ai-operations-phase0-rebase`):**
- `npm run check` → `ok` (exit 0) — all 18 handlers + 6 libs pass `node --check`.
- `npm run build` → success (exit 0): 185 modules, `dist/index.html` 1.12 kB, CSS 12.79 kB, JS **554.20 kB** (gzip 169.26 kB). Vite warns the JS chunk exceeds 500 kB (no code-splitting) — cosmetic, not a failure.
- `npm install` → 3 npm-audit advisories (1 moderate, 2 high) in the dependency tree. No lint or test command exists in `package.json` (`scripts`: dev, build, preview, check only).

---

## 6. Risk summary (corrected)

| # | Risk | Severity | Location | Notes |
|---|---|---|---|---|
| R1 | **Global site-settings writable by any authenticated user.** `portal-settings-set` authorizes on "owns ≥1 loan file," and `portal-loanfile-set` lets *any* authed user self-provision ownership. The `site_settings` row is **publicly read** (live rate + homepage copy). | **High** | `netlify/functions/portal-settings-set.mjs`, `portal-loanfile-set.mjs` | Restrict settings writes to `OURMTG_ADMIN_EMAILS` only. |
| R2 | **`cronGuard` header trust.** `sync-loan-file` treats presence of `x-netlify-event` as proof of a genuine scheduled invocation. If Netlify's edge behavior changes, the cron is externally invokable. | Medium | `_lib/cronGuard.mjs`, `sync-loan-file.mjs` | Mitigated: it only reads `app_state` and idempotently writes `loan_files`. Add `CRON_SECRET` requirement to harden. |
| R3 | **No rate limiting on public `lead-submit`.** | Medium | `netlify/functions/lead-submit.mjs` | Acknowledged in-code; abuse → consent-ledger + GRCRM lead spam. |
| R4 | **Doc/code mismatch.** Header comments on `portal-invite-create` and `portal-preapproval-set` say "OWNER only" but code allows team (`isInternal`). | Low | those files | Likely intended; comments are stale/misleading. |
| R5 | **No automated tests / CI / lint.** Every flow is "verified by code review," not "known good." No delivery tracking on emails (fail-soft/silent). | Medium | `package.json`, `_lib/mailer.mjs` | Phase 1 should add contract tests + CI (`check` + `build`). |
| R6 | **Migration-runbook drift.** `OURMTG_DEPLOY.md` lists 036–038 and "expect 11 tables"; migration **039** (`site_settings`, 12th table) exists but is not in the runbook. `cron_heartbeat` is written but not created in 036–039. | Medium | `docs/OURMTG_DEPLOY.md`, migrations | Verify `cron_heartbeat` exists in the shared project; add 039 to the runbook. |
| R7 | **Service-role-everywhere.** All correctness rests on `resolveAccess`/`isInternal`/`canSeeFinancials` being applied on every path (they currently are, consistently). RLS is only defense-in-depth. | Info | all functions | Any new endpoint must reuse these primitives. |
| R8 | **Stack ≠ spec.** Spec §C says Next.js/Vercel; reality is Vite/React/Netlify. | Info (owner decision) | `docs/OURMTG_SPEC.md` §C | Phase 1 plan targets the actual stack. |

**Security posture is otherwise strong:** magic-link only, private-bucket-only financial docs, server-controlled storage paths, identity-bound single-use invites, realtors structurally blocked from financials in **both** RLS and code, race-safe doc review, human-only pre-approval exposure, immutable consent/audit ledgers, secrets kept server-side (that is why `lead-submit` exists).

---

## 7. What the previous audit missed (existing, working capabilities)

The prior backend-only audit could not have known these exist and work today:

1. **A complete public funnel** — Home, Apply, 6 lead flows, affordability/refi calculators, the `/plan` file builder with a client-side draft pre-approval letter and rate-alarm, `/who` explainer. All **trilingual (EN/ES/RU)**.
2. **Magic-link auth + role dispatcher** with an empty-role chooser and multi-role `?as=` switcher.
3. **Borrower dashboard** — 7-step tracker, what's-next, documents summary, conditions, two-way messages, team contact, multi-file selector.
4. **Secure document flow end-to-end** — checklist, camera/file upload to a private bucket via signed URLs, completion, LO accept/reject with reasons, ad-hoc requests.
5. **Realtor portal** — milestone-only buyer list, published pre-approval band, submit-a-buyer, co-branded `/apply?ref=` link, open-house QR.
6. **LO command center + per-file drill-in** — pipeline chips, stuck panel, active-files table, doc review, pre-approval, invites (incl. escrow/title), condition management, stage/amount editing, messaging.
7. **Standalone mode** — manual loan-file creation independent of GRCRM (`portal-loanfile-set`).
8. **Team access** — processors/assistants (`portal_team`, 038) with owner-level access to all of an owner's files.
9. **Third-party milestone roles** — escrow/title (038), structurally blocked from financials.
10. **Owner-editable site settings** (039) — live rate, loan programs, homepage copy.
11. **Consent ledger actually written** on every lead submission (`portal_consent`, exact text + IP + UA).
12. **The projector** (`sync-loan-file`) that reads GRCRM `app_state` and maintains the `loan_files` projection on a 5-minute cron.
13. **Installable PWA** (manifest + icon).

These are **not** to be rebuilt. Phase 1 extends them (see `OURMTG-IMPLEMENTATION-PLAN.md`).
