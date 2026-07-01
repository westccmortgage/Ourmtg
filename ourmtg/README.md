# OurMTG

Borrower + Realtor + Processor operating layer for **West Coast Capital Mortgage**.

OurMTG is **not** a new CRM and **not** a marketing site. It is the user-facing workflow
layer that sits on top of:

- **GRCRM** — system of record (contacts, deals/pipeline, automations, Arive LOS sync)
- **WCCI.online** — AI loan-strategy layer (server-side, LO-approved before borrowers see it)

This repo is a **separate app** that shares GRCRM's **Supabase project**. It never gives
external users access to GRCRM's `app_state`; borrowers/Realtors read a row-scoped
**projection** of their own loan file.

## What's in here (MVP)

```
src/                          Vite + React SPA (mobile-first) — the OurMTG site
  pages/                      Home (2-button front door), Apply (borrower intake),
                              RealtorLanding, Login (magic link), Invite (accept),
                              Portal (role dispatcher), BorrowerDashboard, Documents,
                              RealtorPortal, LODashboard, LoanFileDetail, Legal
  components/                 Layout + compliance footer, StatusTracker, SubmitBuyerForm,
                              QRCode, RequireAuth, small UI primitives
  lib/                        config, supabase (browser), api (gateway wrappers), auth,
                              useRole, pipeline/format/leadFlows helpers
supabase/migrations/
  036_ourmtg_portal.sql     Projection tables + RLS + private ourmtg-docs bucket
  037_portal_invites.sql    Tokenized, expiring portal_access invites
netlify/functions/
  sync-loan-file.mjs          Projector: GRCRM wcci-deals -> loan_files (cron, every 5m)
  lead-submit.mjs             Public proxy: forwards intake/referral to GRCRM lead-inbound
                              (source token stays server-side, no CORS, no token in bundle)
  portal-invite-create.mjs    LO mints an invite link (owner-authed)
  portal-invite-accept.mjs    Invitee redeems it -> mints portal_access (identity-bound)
  portal-doc-upload-url.mjs   Signed upload URL into private bucket (borrower/coborrower)
  portal-doc-complete.mjs     Mark uploaded, notify LO, confirm borrower
  portal-doc-review.mjs       LO accepts/rejects an uploaded document (owner-only)
  portal-file-detail.mjs      LO file drill-in: docs (+signed download URLs), conditions,
                              timeline (owner-only) — powers the LO review screen
  portal-preapproval-set.mjs  LO issues/clears pre-approval shown to Realtors (owner-only)
  portal-review-queue.mjs     LO queue: missing docs, pending review, stuck files (owner-only)
  portal-status.mjs           Read-only tracker (borrower full / realtor milestone-only)
  portal-checklist.mjs        Required vs uploaded docs (LO internal notes separated)
  _lib/                       Shared helpers (self-contained copies)
docs/
  OURMTG_SPEC.md            Full product + technical spec (A–P)
  OURMTG_GATEWAY.md         Endpoint reference, env, apply order, security notes
```

## Frontend (the site)

Vite + React SPA served by Netlify alongside the gateway functions. Mobile-first,
magic-link auth only (no passwords), NMLS/EHO on every page.

- **Public:** `/` front door · `/apply` borrower intake · `/realtor` buyer referral ·
  `/login` magic link · `/invite?token=…` accept a portal invite.
- **Borrower:** status tracker + "what's next", document checklist with secure camera/file
  upload straight to the private bucket, conditions.
- **Realtor:** milestone-only list of referred buyers (zero financials), submit-a-buyer,
  co-branded link + open-house QR.
- **Loan officer:** pipeline snapshot, stuck-file panel, per-file review (accept/reject
  docs), set pre-approval, invite borrower/realtor.

The app auto-detects role from `portal_access` grants (RLS-readable) and the LO review
queue — there is no separate "who am I" endpoint. Realtor status always goes through
`portal-status` (column-scoped); financial reads never hit `loan_files` directly.

### Run locally

```bash
npm install
cp .env.example .env        # set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (+ server vars)
netlify dev                 # SPA + functions on one origin (recommended)
# or: npm run dev           # SPA only; set VITE_API_BASE to a deployed functions base
npm run build               # production build to dist/
```

## Setup

1. **Env** — copy `.env.example` → set in Netlify (or your host). Point `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE` / `SUPABASE_ANON_KEY` at the **same Supabase project as GRCRM**.
2. **Migrations** — apply in order in the Supabase SQL editor:
   `036_ourmtg_portal.sql`, then `037_portal_invites.sql`.
3. **Deploy** — Netlify (functions auto-discovered from `netlify/functions`). The projector
   self-schedules via its `export const config = { schedule }`.
4. **Verify** — `npm run check` (syntax) and `docs/OURMTG_GATEWAY.md` for curl examples.

## Guardrails (do not violate)

- GRCRM stays source of truth; **never write borrower data back into `app_state`**.
- Financial documents live **only** in the private `ourmtg-docs` bucket, via signed URLs.
- Realtors are **structurally blocked** from documents, conditions, and financial status.
- WCCI output is a **draft** until an LO approves it (DB-enforced: borrowers read only
  `status='approved'`).

## Not built yet

WCCI strategy calls, two-way in-portal chat, processor dashboard, analytics, and the
90-day automation sequences. See `docs/OURMTG_SPEC.md` §F (MVP) and §G (90-day) for the
roadmap. The MVP UI (borrower/Realtor/LO screens) now ships as the Vite + React SPA in
`src/` (spec chose Next.js; this repo is Netlify-native, so the SPA stays on the existing
Netlify deploy alongside the functions).
