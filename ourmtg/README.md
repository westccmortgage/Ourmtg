# OurMTG

Borrower + Realtor + Processor operating layer for **West Coast Capital Mortgage**.

OurMTG is **not** a new CRM and **not** a marketing site. It is the user-facing workflow
layer that sits on top of:

- **GRCRM** — system of record (contacts, deals/pipeline, automations, Arive LOS sync)
- **WCCI.online** — AI loan-strategy layer (server-side, LO-approved before borrowers see it)

This repo is a **separate app** that shares GRCRM's **Supabase project**. It never gives
external users access to GRCRM's `app_state`; borrowers/Realtors read a row-scoped
**projection** of their own loan file.

## What's in here (MVP backend)

```
supabase/migrations/
  036_ourmtg_portal.sql     Projection tables + RLS + private ourmtg-docs bucket
  037_portal_invites.sql    Tokenized, expiring portal_access invites
netlify/functions/
  sync-loan-file.mjs          Projector: GRCRM wcci-deals -> loan_files (cron, every 5m)
  portal-invite-create.mjs    LO mints an invite link (owner-authed)
  portal-invite-accept.mjs    Invitee redeems it -> mints portal_access (identity-bound)
  portal-doc-upload-url.mjs   Signed upload URL into private bucket (borrower/coborrower)
  portal-doc-complete.mjs     Mark uploaded, notify LO, confirm borrower
  portal-doc-review.mjs       LO accepts/rejects an uploaded document (owner-only)
  portal-preapproval-set.mjs  LO issues/clears pre-approval shown to Realtors (owner-only)
  portal-review-queue.mjs     LO queue: missing docs, pending review, stuck files (owner-only)
  portal-status.mjs           Read-only tracker (borrower full / realtor milestone-only)
  portal-checklist.mjs        Required vs uploaded docs (LO internal notes separated)
  _lib/                       Shared helpers (self-contained copies)
docs/
  OURMTG_SPEC.md            Full product + technical spec (A–P)
  OURMTG_GATEWAY.md         Endpoint reference, env, apply order, security notes
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

Frontend (Next.js borrower/Realtor/LO screens), WCCI calls, analytics. See `docs/OURMTG_SPEC.md`
§F (MVP) and §G (90-day) for the roadmap.
