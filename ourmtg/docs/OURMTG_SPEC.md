# OurMTG.com — Technical & Product Specification (v1)

**Product:** OurMTG — Borrower + Realtor + Processor operating layer for West Coast Capital Mortgage
**Owner:** West Coast Capital Mortgage (NMLS: _fill in_), California
**Source of truth:** GRCRM (this repo) · **AI strategy layer:** WCCI.online · **User-facing layer:** OurMTG.com

> This is an **integration-first** spec. OurMTG is **not** a new CRM and **not** a marketing site. It is the
> user-facing workflow layer that sits on top of GRCRM (system of record) and calls WCCI.online for loan
> strategy. Everything below is designed to **reuse GRCRM primitives that already exist** in this codebase:
> the `lead-inbound` webhook, the automations engine (`cron-automations`), the Arive→pipeline sync, Twilio
> SMS, Resend email, and Supabase Auth/Storage.

---

## A. Executive diagnosis

You do not have a website problem. You have a **manual-operations problem**. The chaos is:

1. **Documents.** You ask for bank statements / paystubs by text and email, then chase them for days. There is
   no borrower-facing checklist, no upload target, no automatic reminder. This is where deals stall.
2. **Status.** Borrowers and Realtors text you "where are we?" and you answer each one by hand. GRCRM already
   knows the answer (the Arive sync moves the deal through `lead → preapproval → processing → underwriting →
   conditional → ctc → funded`), but that status is **trapped inside the CRM** — no one outside can see it.
3. **Leads.** Leads land in GRCRM via the webhook, but there's no branded, mortgage-specific front door that
   qualifies them (FHA / VA / DPA / self-employed / jumbo / refi) and routes them cleanly.
4. **Follow-up.** The automations engine exists and is safe, but nothing borrower/Realtor-facing is wired into
   it beyond internal notifications.

What's already solved (don't rebuild it): system of record, lead ingestion, LOS status sync, a **production-grade
automation engine with idempotency/arming/DNC/quiet-hours**, transactional email, and SMS. OurMTG's job is to
put a **secure, mobile-first face** on that engine for the three audiences who are today handled by hand.

**One-line thesis:** OurMTG turns GRCRM's existing pipeline + automation engine into a self-service portal so
documents collect themselves, everyone sees status without texting you, and no lead or follow-up is dropped.

---

## B. Product vision

> **One link for every borrower, Realtor, and processor** — where the loan moves itself forward.

- A **borrower** gets a text with a link, starts an application, sees a checklist, uploads documents from their
  phone, and always knows "what's next" — without you typing a single "please send…".
- A **Realtor** submits a buyer, gets a co-branded intake link and an open-house QR code, and receives milestone
  updates automatically — with **zero access** to the borrower's financials.
- A **processor / LO** opens one dashboard that shows every active file, what's missing, who's stuck, and the one
  next action per file — instead of living in email threads.

OurMTG succeeds when the daily volume of manual "send me X / where are we" texts drops to near zero and
document turnaround time is measured in hours, not days.

---

## C. System architecture

```
   Borrower          Realtor          Processor / LO
      │                 │                  │
      └───────── OurMTG.com (Next.js on Vercel) ──────────┐
                        │  (magic-link auth, row-scoped)  │
                        ▼                                  │
        ┌───────────────────────────────────────┐         │
        │  OurMTG Gateway (server-side only)     │         │
        │  - portal auth (Supabase magic link)   │         │
        │  - scoped reads of the loan-file       │         │
        │    PROJECTION tables                    │         │
        │  - writes leads → GRCRM lead-inbound    │         │
        │  - writes doc uploads → private bucket  │         │
        │  - calls WCCI for strategy (LO-gated)   │         │
        └───────────────────────────────────────┘         │
                        │                                  │
             (same Supabase project)                       │
                        ▼                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  GRCRM (this repo) = SOURCE OF TRUTH                          │
   │  - app_state doc-store: wcci-contacts / wcci-deals / tasks   │
   │  - lead-inbound.mjs  (public webhook, token per source)      │
   │  - cron-automations.mjs (the Automation Brain)               │
   │  - Arive (LOS) → pipeline stage sync (already live)          │
   │  - Twilio SMS · Resend email · Supabase Storage              │
   └──────────────────────────────────────────────────────────────┘
                        │
                        ▼  (server-to-server, LO reviews before borrower sees)
             WCCI.online — AI loan strategy / intelligence
```

**Key decisions (no hedging):**

1. **OurMTG is a separate Next.js app** on its own domain, **not** a second CRM. It has **no** direct access to
   GRCRM's `app_state` blobs (a borrower must never be able to read the broker's whole contact array).
2. **Reuse ONE Supabase project** (GRCRM's). Do not stand up a second database — it would force a sync you'd
   fight forever. Instead add **projection tables** (`loan_files`, `loan_documents`, `loan_conditions`,
   `loan_messages`, `portal_users`, `portal_access`) that are **row-level-scoped by RLS** to the external user.
3. **The projection is written by GRCRM (service role), read by the portal user (RLS).** GRCRM stays source of
   truth; the projection is the borrower-safe view of one file. This is the honest design given that CRM data
   lives in per-broker JSON blobs that can't be RLS'd per borrower.
4. **New leads go through the existing `lead-inbound` webhook.** It already dedupes contacts, creates the deal,
   applies lead routing, notifies the LO, and (via arming) lets the automation engine pick it up. Do not write a
   parallel lead path.
5. **Documents go to a NEW private bucket `ourmtg-docs`.** The existing `crm-media` bucket is **public-read** and
   must never hold financial documents.
6. **WCCI is called server-side only, and its output is a DRAFT** attached to the deal that an LO must approve
   before the borrower sees anything. AI never speaks to a borrower with an unreviewed strategy.

---

## D. User roles

| Role | Auth | Sees | Never sees | Notes |
|---|---|---|---|---|
| **Borrower / Co-borrower** | Magic link (SMS/email), no password | Own loan file: status, checklist, conditions, messages, upload | Any other borrower; broker CRM; internal notes marked private | Co-borrower is a second `portal_user` linked to the same `loan_file` |
| **Realtor / Partner** | Magic link | Milestone status of buyers they referred; submit-buyer form; their co-branded link + QR | **Borrower financial documents**, income, assets, credit, conditions detail | Milestones only: pre-approved / in processing / UW / CTC / closing / funded |
| **Processor** | Existing GRCRM login (team member) | Team queue: all active files, missing docs, conditions, responsiveness, next action | Billing/admin unless granted | Uses GRCRM team permissions (`none/view/edit`) already in the codebase |
| **Loan Officer** | Existing GRCRM login | Command center: their pipeline, stuck files, WCCI drafts to approve, message drafts to approve | Other LOs' files unless manager | Owner or team member with `mortgage` role |
| **Admin** | Existing GRCRM login | Everything + settings, compliance config, audit logs, portal branding | — | Existing GRCRM owner/admin role |

Roles map onto GRCRM's existing model: internal roles use `profiles.features` (`mortgage`, `realtor`) + team
per-module permissions; **external** roles (borrower, realtor) are a **new identity type** in `portal_users`,
kept entirely separate from `auth.users` CRM accounts.

---

## E. Full feature list (by module)

### 1. Borrower Assistant
- Conversational intake (chat-style, mobile-first) → produces a structured 1003-lite.
- Application start + resume (magic-link, no password).
- Dynamic **document checklist** driven by loan type (FHA/VA/Conventional/Jumbo/Self-employed/Refi).
- **Secure upload** (camera or file) to private `ourmtg-docs` bucket; each upload creates a `loan_documents` row
  and pings the LO.
- **Missing-document reminders** at 24h / 72h (via the automation engine, not ad-hoc).
- **Loan status tracker** — a 7-step bar mapped 1:1 to GRCRM pipeline stages (fed by the Arive sync).
- **Underwriting condition center** — each condition is a row the borrower can satisfy by uploading/answering.
- **"What's next?"** plain-English explanation of the current stage + the single next action.
- SMS + email updates on every milestone.
- Fully responsive PWA (installable to home screen).

### 2. Realtor Portal
- Submit a buyer (name/phone/email/price range) → creates a lead in GRCRM tagged `Realtor referral` + partner
  attribution.
- **Co-branded intake link** (LO + Realtor logos) the Realtor sends to their buyers.
- **Open-house QR** that captures sign-ins (reuses GRCRM's open-house capture endpoint).
- **Milestone-only** updates per referred buyer (no financials).
- Pre-approval status (issued / amount band / expiration) — LO controls what's exposed.
- Closing timeline (est. close date, current stage).
- Automated Realtor notifications on stage changes (via automation engine, `recipient: 'partner'`).

### 3. Processor / Loan-Team View
- All active files with stage, age, and a computed **"stuck" flag**.
- Missing documents and outstanding conditions per file.
- Uploaded documents (with preview) and borrower responsiveness score (last activity).
- Realtor attached to each file.
- **Next action** per file (the single most important thing to do).
- Closing calendar.
- Full communication history (SMS/email/portal messages) per file.

### 4. Lead Engine (8 flows)
DPA check · FHA qualification · VA eligibility · Self-employed review · Jumbo readiness · Refinance review ·
Affordability calculator · Realtor buyer referral. Each flow: creates/updates a GRCRM contact, triggers SMS+email,
sets a status/tag, creates an LO task, notifies the LO, offers calendar booking, and arms the correct workflow.

### 5. Automation Brain
21 workflows (§J) built on the **existing** `cron-automations` engine — triggers, sequences, DNC, quiet hours,
NMLS footer, and per-contact 24h caps are already implemented and safe.

### 6. AI Assistant Layer (§ below in F/H, gated by compliance)
Borrower Q&A, document-request explanations, status explanations, LO file summaries, drafted messages, stuck-file
detection, next-best-action — **all draft-only or FAQ-bounded**, with human approval before anything external
goes out. Never promises approval; never makes rate/DPA claims.

### 7. Compliance Layer
NMLS display, EHO, privacy/terms, TCPA SMS consent + email consent capture and storage, private encrypted document
handling, audit logs, role-based access, encryption at rest/in transit, access logs, calculator + DPA disclaimers,
no-guarantee language enforcement, data-retention rules (§M).

### 8. Integration Plan (§I)
### 9. UX Screens (§K)
### 10. Message Library (§L)
### 11–13. MVP / 90-day / stack (§F, §G, tech-stack subsection)

---

## F. MVP scope (ruthless — 30 days)

**Goal of MVP:** kill manual document-chasing and status-texting for *new* files. Nothing else.

**Build:**
1. **Borrower intake** (form-based, not full conversational AI yet) → posts to `lead-inbound`, creates deal.
2. **Document checklist + secure upload** — private `ourmtg-docs` bucket, `loan_documents` rows, LO notified.
3. **Loan status tracker** — read-only 7-step bar from the `loan_files` projection (fed by existing Arive sync).
4. **GRCRM lead sync** — reuse the webhook; no new ingest path.
5. **Automated SMS/email reminders** — wire the 24h/72h missing-doc rules into the existing automation engine.
6. **Realtor buyer submission** — single form → lead tagged `Realtor referral`, partner attribution, LO notified.
7. **Loan Officer dashboard** — active files, missing docs, next action, one screen. (LO uses existing GRCRM login.)

**Explicitly NOT in MVP:** conversational AI, full processor dashboard, WCCI integration, advanced Realtor portal,
reactivation, analytics, annual reviews, co-branded asset generation, in-portal two-way chat. (See §O.)

**Definition of done for MVP:** a real borrower receives a link by SMS, uploads 3 documents from their phone, sees
their status advance when Arive updates, and gets an automatic reminder if a document is missing at 24h — with the
LO seeing all of it in GRCRM and never sending a manual "please send" text.

---

## G. 90-day roadmap (after MVP)

| Weeks | Add | Built on |
|---|---|---|
| 5–6 | **Conditional/condition center** (borrower satisfies UW conditions in-portal) | `loan_conditions` table |
| 5–6 | **Processor dashboard** (team queue, stuck flags, responsiveness) | GRCRM team perms |
| 7–8 | **AI borrower assistant** (FAQ + doc-request explainer, bounded) | WCCI + guardrails |
| 7–8 | **Advanced Realtor portal** (per-buyer milestones, co-branded links, QR) | open-house + partner attribution |
| 9–10 | **WCCI integration** (loan strategy draft, LO-gated) | server-to-server + `loan_strategy` |
| 11 | **Past-client reactivation + annual mortgage review** | automation sequences + `closing.anniversary` trigger |
| 12 | **Analytics** (funnel: lead→app→docs→submitted→funded; doc turnaround time) | reports module |

---

## H. Database schema (new tables — additive, in GRCRM's Supabase project)

All new tables are **service-role write, RLS-scoped read**. External portal users authenticate as a distinct
identity and can only ever read rows tied to them through `portal_access`.

```sql
-- ============================================================
-- OurMTG portal schema (migration 036_ourmtg_portal.sql)
-- External-facing projection of GRCRM loan files. GRCRM writes; portal reads (RLS).
-- ============================================================

-- Portal users: borrowers, co-borrowers, realtors. Separate identity from CRM auth.users.
-- (These ARE Supabase auth.users too, but flagged as external and never given CRM RLS access.)
create table if not exists public.portal_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('borrower','coborrower','realtor')),
  full_name   text,
  email       text,
  phone       text,
  created_at  timestamptz default now()
);

-- Access grants: which portal user may see which loan file, and at what visibility.
create table if not exists public.portal_access (
  id            uuid primary key default gen_random_uuid(),
  portal_user   uuid not null references auth.users(id) on delete cascade,
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  visibility    text not null default 'borrower'
                 check (visibility in ('borrower','coborrower','realtor')),
  created_at    timestamptz default now(),
  unique (portal_user, loan_file_id)
);

-- Loan-file projection: the borrower-safe view of ONE GRCRM deal.
-- owner_user_id = the broker (GRCRM auth.users.id) who owns the source deal.
-- source_deal_id = the deal id inside that broker's wcci-deals doc array.
create table if not exists public.loan_files (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  source_deal_id  text not null,
  loan_number     text,
  borrower_name   text,
  realtor_contact_id text,
  loan_type       text,     -- FHA/VA/Conventional/Jumbo/USDA/...
  purpose         text,     -- Purchase / Rate-Term Refi / Cash-out Refi / HELOC
  stage           text not null default 'lead',  -- mirrors pipeline: lead..funded
  amount          numeric,
  est_close_date  date,
  preapproval_amount numeric,           -- what the Realtor is allowed to see (LO-set)
  preapproval_expires date,
  updated_at      timestamptz default now(),
  created_at      timestamptz default now(),
  unique (owner_user_id, source_deal_id)
);

-- Document requests + uploads. `key` drives the checklist; `status` its state.
create table if not exists public.loan_documents (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  doc_key       text not null,          -- 'paystub_30d','bank_2mo','w2_2yr','id_front',...
  label         text not null,
  who           text not null default 'borrower' check (who in ('borrower','coborrower')),
  status        text not null default 'requested'
                 check (status in ('requested','uploaded','accepted','rejected')),
  storage_path  text,                   -- ourmtg-docs/<owner>/<loan_file>/<uuid>
  reject_reason text,
  requested_at  timestamptz default now(),
  uploaded_at   timestamptz,
  reviewed_at   timestamptz
);

-- Underwriting conditions the borrower can satisfy in-portal.
create table if not exists public.loan_conditions (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  detail        text,
  status        text not null default 'open'
                 check (status in ('open','submitted','cleared')),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Portal messages (borrower/realtor <-> team). Outbound-to-external is LO-approved.
create table if not exists public.loan_messages (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  direction     text not null check (direction in ('in','out')),
  author_role   text not null,          -- borrower/realtor/lo/processor/system
  body          text not null,
  channel       text default 'portal',  -- portal/sms/email
  created_at    timestamptz default now()
);

-- Consent ledger (TCPA/CAN-SPAM) — immutable audit of every consent event.
create table if not exists public.portal_consent (
  id            uuid primary key default gen_random_uuid(),
  portal_user   uuid references auth.users(id) on delete set null,
  loan_file_id  uuid references public.loan_files(id) on delete set null,
  consent_type  text not null,          -- 'sms','email','econsent','credit_pull_auth'
  granted       boolean not null,
  ip            text,
  user_agent    text,
  text_shown    text,                   -- exact disclosure text at time of consent
  created_at    timestamptz default now()
);

-- Access log (who viewed/downloaded which document).
create table if not exists public.portal_access_log (
  id            uuid primary key default gen_random_uuid(),
  portal_user   uuid references auth.users(id) on delete set null,
  loan_file_id  uuid references public.loan_files(id) on delete set null,
  action        text not null,          -- 'view_file','download_doc','upload_doc','login'
  target        text,
  ip            text,
  created_at    timestamptz default now()
);

-- WCCI strategy drafts (LO-gated before borrower visibility).
create table if not exists public.loan_strategy (
  id            uuid primary key default gen_random_uuid(),
  loan_file_id  uuid not null references public.loan_files(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source        text default 'wcci',
  payload       jsonb not null,         -- raw WCCI response
  summary       text,                   -- LO-editable borrower-facing summary
  status        text not null default 'draft'
                 check (status in ('draft','approved','hidden')),
  created_at    timestamptz default now(),
  approved_at   timestamptz
);

-- ---------- RLS: external users read only their own file ----------
alter table public.loan_files      enable row level security;
alter table public.loan_documents  enable row level security;
alter table public.loan_conditions enable row level security;
alter table public.loan_messages   enable row level security;

-- Borrower/coborrower: full file. Realtor: milestone fields only (enforced at the
-- API layer by selecting a whitelisted column set; RLS gates the ROW, API gates the COLUMNS).
create policy portal_read_files on public.loan_files for select using (
  exists (select 1 from public.portal_access pa
          where pa.loan_file_id = loan_files.id and pa.portal_user = auth.uid())
);
create policy portal_read_docs on public.loan_documents for select using (
  exists (select 1 from public.portal_access pa
          where pa.loan_file_id = loan_documents.loan_file_id
            and pa.portal_user = auth.uid()
            and pa.visibility in ('borrower','coborrower'))   -- realtors NEVER see docs
);
create policy portal_read_conditions on public.loan_conditions for select using (
  exists (select 1 from public.portal_access pa
          where pa.loan_file_id = loan_conditions.loan_file_id
            and pa.portal_user = auth.uid()
            and pa.visibility in ('borrower','coborrower'))
);
create policy portal_read_messages on public.loan_messages for select using (
  exists (select 1 from public.portal_access pa
          where pa.loan_file_id = loan_messages.loan_file_id and pa.portal_user = auth.uid())
);
-- No INSERT/UPDATE/DELETE policies for external role: all writes go through the
-- server-side gateway (service role), which enforces business rules + logging.

-- ---------- Private document bucket ----------
insert into storage.buckets (id, name, public) values ('ourmtg-docs','ourmtg-docs', false)
on conflict (id) do update set public = false;
-- Access ONLY via signed URLs minted server-side after a portal_access check. No public read.
```

**Why a projection and not direct access:** GRCRM stores each broker's contacts/deals as one big JSON array in
that broker's `app_state` row. There is no per-borrower row to RLS. The projection gives every loan file its own
row set that can be safely scoped to exactly the borrower/Realtor entitled to it — without exposing the blob.

---

## I. API / integration map

### I.1 — GRCRM (source of truth)

| Concern | Mechanism | Direction | Status |
|---|---|---|---|
| **New lead (all 8 flows)** | `POST /.netlify/functions/lead-inbound?token=<source>` | OurMTG → GRCRM | **Exists** — reuse as-is |
| **Loan status** | Arive → `lead-inbound` (Arive branch) → deal stage → **sync into `loan_files`** | GRCRM → projection | Arive part exists; add projector |
| **Projection sync** | New fn `sync-loan-file` (service role): on deal write, upsert `loan_files`/`loan_conditions` | GRCRM → OurMTG tables | **Build** |
| **Document uploaded** | Gateway writes `loan_documents` + calls a GRCRM task-create so the LO gets a task | OurMTG → GRCRM | **Build (thin)** |
| **Realtor record** | Partner attribution on the referred lead (`referredBy`/partner contact) | OurMTG → GRCRM | Reuse partner model |
| **Messages / audit** | `loan_messages`, `portal_access_log`, `portal_consent` | Two-way | **Build** |
| **Automations** | Events land in GRCRM data; `cron-automations` fires (arming/DNC/caps already safe) | internal | **Exists** — wire rules |

**Webhook contract (already implemented) — the lead-flow integration point:**
- Token: 24-char hex from `lead_sources`, passed as `?token=` (or header/body).
- Dedupe: email, then normalized phone. Merge tags on match; new contact type `Lead` otherwise.
- Auto: lead routing (round-robin), LO email notify, `lead_inbound_log` audit, automation arming.
- Never 500 on bad input → clean 4xx. **OurMTG lead flows must POST this exact shape** and add a `source`/tag
  per flow (e.g. `dpa_check`, `va_eligibility`) so routing + automations can branch.

**Fallback if a richer GRCRM API isn't available:** the webhook + the shared Supabase project are enough. The
projector reads `app_state.wcci-deals` (service role) and writes the projection — no new GRCRM API surface is
strictly required for MVP. Document→task can also be delivered as an inbound note on the contact via the same
webhook if a dedicated task endpoint isn't built yet.

### I.2 — WCCI.online (AI loan strategy)

| Question | Answer |
|---|---|
| **When triggered** | (a) borrower finishes intake, (b) LO clicks "Get strategy" on a file, (c) refi/DPA flow completes |
| **What is sent** | Non-PII loan shape: loan type, purpose, price/value, LTV, DTI band, credit band, occupancy, state, program flags. **No SSN, no full financials.** |
| **What comes back** | Structured strategy: recommended program(s), DPA eligibility signal, rate/price scenario, next steps |
| **Transport** | Server-to-server HTTPS from the OurMTG gateway (never browser→WCCI). Signed request; timeout + fail-soft |
| **Review gate** | Response stored in `loan_strategy` as `status='draft'`. **LO must approve** (edit summary → `approved`) before it appears in the borrower portal. Unapproved drafts are invisible to borrowers. |

---

## J. Automation workflows (21)

All run on the **existing** `cron-automations` reconciler: server-side, idempotent, **armed on enable so the
existing database is never retro-blasted**, DNC-respecting, quiet-hours-aware, NMLS-appended for external
mortgage messages, capped at 1 email + 1 SMS per contact per rule per 24h. Triggers use `lead.created`,
`deal.stage_changed:<stage>`, sequence steps, and (90-day) `no_reply_days` / `closing.anniversary`.

Format: **Trigger → Action → Message → Owner → Fallback → Stop condition.**

| # | Workflow | Trigger | Action | Message (channel) | Owner | Fallback | Stop |
|---|---|---|---|---|---|---|---|
| 1 | New lead | `lead.created` | Task "Call {{firstName}} (5-min rule)" + welcome | SMS+email welcome | LO | If no phone → email only | Reply / booking made |
| 2 | No response | `no_reply_days:1,3,5,7,10` seq | Re-touch each step | SMS "still want to move forward?" | LO | SMS fail → email | Reply / disqualified |
| 3 | App started, not finished | portal `app_started` no submit 24h | Reminder + resume link | SMS+email "finish in 3 min" | LO | — | App submitted |
| 4 | App submitted | portal `app_submitted` | Confirm + set expectations; task LO review | Email "we got it" | LO | — | Docs requested |
| 5 | Documents requested | LO/portal creates `loan_documents` | Send checklist link | SMS+email checklist | LO | — | All accepted |
| 6 | Missing docs 24h | doc `requested` >24h | Reminder #1 | SMS "1 quick thing left" | LO | SMS fail→email | Uploaded |
| 7 | Missing docs 72h | doc `requested` >72h | Reminder #2 + LO task to call | SMS+email + LO alert | LO | Escalate to processor | Uploaded |
| 8 | Docs uploaded | doc `uploaded` | Thank + "under review"; task LO to verify | SMS "got it, reviewing" | LO | — | Accepted/rejected |
| 9 | Submitted to processing | `deal.stage_changed:processing` | Status update + Realtor milestone | Email borrower + partner | LO | — | Next stage |
| 10 | Submitted to underwriting | `deal.stage_changed:underwriting` | Status update | Email borrower "in underwriting" | LO | — | Next stage |
| 11 | Conditions issued | `deal.stage_changed:conditional` / condition created | Open condition center; request items | SMS+email "a few conditions" | Processor | — | Conditions cleared |
| 12 | Conditions still missing | condition `open` >48h | Reminder + LO task | SMS + LO alert | Processor | Escalate LO | Submitted/cleared |
| 13 | Conditional approval | `deal.stage_changed:conditional` | Reassure + explain | Email "approved with conditions — here's what's left" | LO | — | CTC |
| 14 | Clear to close | `deal.stage_changed:ctc` | Celebrate + schedule signing; notify Realtor | SMS+email + partner milestone | LO | — | Closing scheduled |
| 15 | Closing scheduled | est_close_date set | Confirm date/time/place + what to bring | SMS+email | LO | — | Funded |
| 16 | Funded | `deal.stage_changed:funded` | Congrats; tag `closed-client`; notify Realtor | SMS+email + partner "your buyer closed" | LO | — | (event) |
| 17 | Review request | funded + 3 days | Ask for Google review | SMS+email review link | LO | — | Reviewed / opted out |
| 18 | Referral request | funded + 14 days | Ask for referral | Email "know anyone buying?" | LO | — | Opted out |
| 19 | Annual mortgage review | `closing.anniversary` (yearly) | Offer review; check refi/equity | Email + LO task | LO | — | Booked / opted out |
| 20 | Past-client reactivation | tag `closed-client` + rate drop / 6-mo dormant | Re-engage | Email "worth a look?" | LO | — | Reply / opted out |
| 21 | Realtor buyer received | `lead.created` w/ tag `Realtor referral` | Confirm to Realtor + task LO | Email Realtor + SMS buyer | LO | — | Buyer contacted |

Owner column = who the task/escalation is assigned to (LO or Processor). Every external message carries the NMLS
footer automatically (already implemented in the engine) and is suppressed for DNC/opted-out contacts.

---

## K. UX screen descriptions (wireframes)

1. **OurMTG home (`ourmtg.com`)** — Not a marketing page. A single value prop + two buttons: **"Start your
   application"** (borrower) and **"I'm a Realtor"** (partner). NMLS + EHO in footer. One-tap "sign in" (magic
   link). Mobile-first, loads in <1s.
2. **Borrower login** — Phone or email → "we texted you a link". No passwords. Consent checkbox (TCPA/e-consent)
   with exact disclosure captured to `portal_consent`.
3. **Borrower dashboard** — Top: **status bar** (7 steps, current highlighted) + one-line "What's next". Cards:
   **Documents (X of Y done)**, **Conditions (if any)**, **Messages**, **Your team** (LO photo/NMLS, tap-to-call).
4. **Upload documents** — Checklist grouped by borrower/co-borrower. Each item: label, "why we need this" tooltip,
   camera/upload button, status chip (Requested / Uploaded / Accepted / Needs another). Big tap targets.
5. **Loan status** — The 7-step tracker expanded, each step with a plain-English description + timestamp when
   reached. "Est. closing: {{date}}". No jargon.
6. **Condition center** — List of UW conditions; each is a task the borrower can satisfy (upload/answer). Clear
   "Submitted — under review" states. Never shows raw UW language without a friendly rewrite.
7. **Realtor portal** — List of referred buyers with a **milestone chip only** (Pre-approved / In processing / UW
   / CTC / Closing / Funded). No financials anywhere. Buttons: **Submit a buyer**, **My co-branded link**, **My QR**.
8. **Submit buyer** — Name, phone, email, price range, notes → posts to `lead-inbound` tagged `Realtor referral`.
   Confirmation + "we'll keep you posted automatically".
9. **Processor dashboard** — Table of active files: borrower, stage, **days in stage**, missing-docs count,
   open-conditions count, responsiveness dot, Realtor, **next action**, **stuck flag**. Filters + closing calendar.
10. **LO command center** — Pipeline by stage (value + count), **stuck files** panel, **WCCI drafts to approve**,
    **message drafts to approve**, today's tasks, new leads. One "act" button per row.
11. **Admin settings** — Branding (logos, colors, domain), senders (Resend/Twilio), compliance text (NMLS by
    state, DPA disclaimers, retention), lead-source tokens, portal access grants, audit-log viewer.

---

## L. Message templates (SMS + email)

Rules baked in: NMLS # auto-appended to every external message (engine already does this), EHO on emails, no
guarantees, no specific-rate promises, opt-out on every SMS ("Reply STOP to opt out"). `{{...}}` are the engine's
existing merge vars.

**Legend:** `{{firstName}}`, `{{loName}}`, `{{nmls}}`, `{{link}}`, `{{stage}}`, `{{closeDate}}`, `{{realtor}}`.

| Key | SMS | Email subject → body (first line) |
|---|---|---|
| **welcome** | Hi {{firstName}}, it's {{loName}} w/ West Coast Capital Mortgage. Start your secure application here: {{link}} Reply STOP to opt out. | *Welcome — let's get you started* → "Here's your secure link to start your application. It takes about 5 minutes and saves as you go." |
| **finish_application** | {{firstName}}, you're almost there — finish your application (3 min): {{link}} | *You're one step from done* → "Pick up right where you left off. Your progress is saved." |
| **upload_documents** | {{firstName}}, here's your document checklist. Snap a photo from your phone: {{link}} | *Your document checklist is ready* → "Upload securely from your phone — no scanner needed." |
| **missing_documents** | Quick nudge, {{firstName}} — we still need a couple items to keep your loan moving: {{link}} | *A couple items still needed* → "We're ready to move forward as soon as these come in." |
| **application_received** | Got it, {{firstName}}! Your application is in. We'll be in touch with next steps shortly. | *We received your application* → "Thanks {{firstName}} — our team is reviewing and will reach out with next steps." |
| **preapproval_next_steps** | Great news {{firstName}} — you're pre-approved. Here's what happens next: {{link}} | *You're pre-approved — next steps* → "Congrats! Here's what to expect and how to make a strong offer." |
| **underwriting_update** | {{firstName}}, your loan is now in underwriting — the review stage. We'll update you as it moves. | *Your loan is in underwriting* → "This is the detailed review stage. No action needed right now — we'll reach out if we need anything." |
| **conditions_needed** | {{firstName}}, underwriting asked for a few items. Knock them out here: {{link}} | *A few conditions to clear* → "You're approved with conditions — here's exactly what's left." |
| **clear_to_close** | 🎉 {{firstName}}, you're CLEAR TO CLOSE! We'll coordinate your signing. Details soon. | *Clear to close!* → "Huge milestone — your loan is cleared. We'll send signing details shortly." |
| **closing_scheduled** | {{firstName}}, your closing is set for {{closeDate}}. What to bring: {{link}} | *Your closing is scheduled* → "Here are the date, time, location, and what to bring." |
| **funded_congrats** | 🏡 Congratulations {{firstName}} — your loan funded! Thank you for trusting us. | *Congratulations — your loan funded!* → "It's official. Thank you for letting us be part of it." |
| **review_request** | {{firstName}}, if we earned it, a quick review means the world: {{link}} | *How did we do?* → "A 60-second review helps another family find us. Thank you!" |
| **realtor_buyer_received** | {{realtor}}, got your buyer referral — we're on it and will keep you posted automatically. | *We received your buyer* → "Thanks {{realtor}} — we'll update you at every milestone. No need to check in." |
| **realtor_milestone_update** | Update: your buyer reached {{stage}}. Est. close {{closeDate}}. — {{loName}} | *Your buyer's loan reached {{stage}}* → "Milestone update on your referred buyer. We'll notify you at the next step." |
| **annual_mortgage_review** | {{firstName}}, it's been a year! Worth a 10-min mortgage check-up? Book here: {{link}} | *Your annual mortgage review* → "Rates and your equity change. Let's make sure your loan still fits." |

All email bodies end with: `Equal Housing Opportunity · West Coast Capital Mortgage · NMLS #{{nmls}} · This is
not a commitment to lend. · Unsubscribe.` SMS templates never claim approval and always include STOP.

---

## M. Compliance checklist

**Display / disclosure**
- [ ] NMLS # (company + individual LO) on every page footer and every external message (engine auto-appends).
- [ ] Equal Housing Opportunity logo + text on site and emails.
- [ ] Privacy Policy + Terms of Use (GRCRM already has `/legal/privacy`, `/legal/terms` — mirror for OurMTG).
- [ ] Calculator disclaimer: "estimates only, not a loan offer or approval."
- [ ] DPA disclaimer: "program availability, funding, and eligibility change; subject to program guidelines."
- [ ] No "guaranteed approval / guaranteed rate" language anywhere — enforce with a lint list of banned phrases.

**Consent (TCPA / CAN-SPAM)**
- [ ] Explicit SMS consent checkbox with exact disclosure text, stored in `portal_consent` (text, IP, UA, time).
- [ ] Explicit email consent; every email has a working unsubscribe (reuse GRCRM unsubscribe fn + DNC).
- [ ] "Reply STOP" honored → write to GRCRM DNC (already enforced by the automation engine).
- [ ] E-consent (ESIGN) acknowledgment before electronic document exchange.
- [ ] Credit-pull authorization captured separately before any WCCI/credit action.

**Data security**
- [ ] Financial documents in **private** `ourmtg-docs` bucket; access only via short-lived signed URLs minted
      after a `portal_access` check. Never public.
- [ ] Encryption in transit (TLS) and at rest (Supabase/Postgres + storage encryption).
- [ ] Role-based access: RLS on all projection tables; Realtors structurally blocked from documents/conditions.
- [ ] Audit logs: `portal_access_log` (view/download/upload/login) + existing `lead_inbound_log`.
- [ ] Access logs reviewable in admin.
- [ ] Data retention: define per doc type (e.g. retain loan docs per federal/state requirement; purge abandoned
      intake PII after N days). Honor GRCRM's existing data-deletion flow (`/legal/data-deletion`).
- [ ] No PII sent to WCCI (loan shape only; no SSN/full financials).

**Advertising**
- [ ] No misleading rate/DPA claims; all figures marked "estimated, subject to change."
- [ ] AI never states or implies approval; canned "your loan officer will confirm" fallback for anything binding.

---

## N. Build priority list

1. Migration `036_ourmtg_portal.sql` (tables + RLS + private bucket).
2. Loan-file **projector** (`sync-loan-file`) — reads `wcci-deals`, upserts `loan_files`/`loan_conditions`.
3. Portal **auth + gateway** (magic link, `portal_access` enforcement, signed-URL doc access).
4. Borrower **intake → `lead-inbound`** (reuse webhook; add per-flow tags).
5. Borrower **document checklist + upload** (private bucket, `loan_documents`, LO task/notify).
6. Borrower **status tracker** (read `loan_files`).
7. Automation rules **#1, #5, #6, #7, #8** wired into `cron-automations` (armed, DNC-safe).
8. **Realtor submit-buyer** flow (tagged, partner attribution).
9. **LO dashboard** (active files, missing docs, next action).
10. Compliance surface: consent capture, NMLS/EHO, disclaimers, audit logging.
11. (90-day) condition center, processor dashboard, AI assistant, WCCI, reactivation, analytics.

---

## O. What NOT to build

- ❌ A new CRM or anything that duplicates GRCRM as system of record.
- ❌ A second database / separate Supabase project (forces an eternal sync).
- ❌ Another marketing website / brochureware. OurMTG's home is a 2-button front door, nothing more.
- ❌ A parallel lead-ingest path — the `lead-inbound` webhook already does dedupe/routing/notify/arming.
- ❌ Passwords for borrowers/Realtors — magic link only (fewer support tickets, better security).
- ❌ Storing financial docs in the public `crm-media` bucket — ever.
- ❌ Client-side calls to WCCI, or showing unreviewed AI strategy to borrowers.
- ❌ AI that quotes rates, promises approval, or asserts DPA eligibility as fact.
- ❌ Two-way live chat, e-sign, native mobile apps, or a full document OCR pipeline in v1 (later, if earned).
- ❌ Retroactive automation blasts — arming is mandatory (the engine already enforces it).

---

## P. Exact next 10 steps

1. **Confirm the boundary decision:** OurMTG = separate Next.js app on `ourmtg.com`, **reusing GRCRM's Supabase
   project** + `lead-inbound` webhook + `cron-automations`. (This spec assumes yes.)
2. **Fill the constants:** company + LO NMLS #s, from-domain for Resend, Twilio A2P sender, WCCI base URL + auth.
3. **Write migration `036_ourmtg_portal.sql`** (tables, RLS, private `ourmtg-docs` bucket) and apply it.
4. **Build the projector** `sync-loan-file.mjs`: on deal change, upsert `loan_files` (+ conditions). Backfill once.
5. **Stand up the Next.js app** with Supabase magic-link auth for `portal_users` and the `portal_access` gate.
6. **Ship borrower intake** posting to `lead-inbound` with per-flow tags; verify a real lead + deal appear in GRCRM.
7. **Ship document checklist + upload** to `ourmtg-docs`, writing `loan_documents` and creating an LO task/notify.
8. **Ship the read-only status tracker** from `loan_files`; verify it advances when Arive moves a deal's stage.
9. **Enable automation rules #1/#5/#6/#7/#8** (armed, DNC-safe) and test the 24h/72h missing-doc reminders end-to-end.
10. **Ship the LO dashboard + compliance surface** (consent capture, NMLS/EHO, disclaimers, `portal_access_log`),
    then pilot with **one real borrower and one real Realtor** before widening.

---

### Tech-stack recommendation (module 13)

| Option | Fast launch | Cost | Security | Scale | GRCRM fit | Compliance | Maintenance | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Next.js + Supabase + Twilio + Resend + GRCRM webhook** | ✅ | ✅ | ✅ | ✅ | ✅ (same Supabase, same webhook, same engine) | ✅ | ✅ | **CHOSEN** |
| Webflow/Framer + Supabase + Make/Zapier + Twilio | ⚠️ fast UI | ⚠️ Make costs scale badly | ❌ doc-upload + RLS awkward | ⚠️ | ⚠️ glue-heavy | ❌ hard to audit | ❌ fragile | No |
| WordPress + plugins | ⚠️ | ⚠️ | ❌ plugin attack surface | ❌ | ❌ | ❌ | ❌ | No |
| GoHighLevel / HubSpot layer | ✅ | ❌ per-seat + lock-in | ⚠️ | ⚠️ | ❌ wants to BE the CRM; conflicts with GRCRM-as-truth | ⚠️ | ⚠️ | No |

**Why Next.js + Supabase wins here specifically:** GRCRM already runs on **Supabase + Resend + Twilio + serverless
functions**. Choosing the same stack means OurMTG shares the database, the auth, the storage, the SMS/email
senders, and the automation engine — **zero new integration surface, one security model, one audit trail.** Every
other option adds a system that either duplicates GRCRM or bolts on brittle glue. Next.js on Vercel gives the
mobile-first PWA borrowers need; Supabase RLS + a private bucket gives the document security compliance demands.

---

*End of spec v1. This document is the contract: build against it. Open questions for the owner are the two
decisions in step P.1 and the NMLS/WCCI constants in P.2.*
