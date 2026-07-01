# OurMTG MVP gateway — server functions

The borrower/Realtor-facing gateway that sits between the OurMTG app and GRCRM. All
functions are Netlify functions in `netlify/functions/`. They authenticate the caller's
Supabase JWT, then do all DB work with the **service role** while enforcing access in
code via `portal_access`. **No portal user ever touches `app_state`.**

Apply migrations first (in order): `036_ourmtg_portal.sql`, then `037_portal_invites.sql`.

## Environment
| Var | Used for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` | service-role DB + storage |
| `SUPABASE_ANON_KEY` (or `VITE_SUPABASE_ANON_KEY`) | verifying the caller JWT |
| `RESEND_PLATFORM_KEY` | LO/borrower notification emails (fail-soft if unset) |
| `OURMTG_URL` | base URL in invite/notification links (default `https://ourmtg.com`) |

## Endpoints

All calls require `Authorization: Bearer <supabase-jwt>`.

### 1. `POST /portal-invite-create` — mint an invite (LO/owner)
Body: `{ loanFileId, role: 'borrower'|'coborrower'|'realtor', email?, phone?, name?, expiresInDays? }`
- Authorizes: caller must be `loan_files.owner_user_id`.
- Creates a `portal_invites` row (32-hex token, default 14-day expiry), emails the link.
- → `{ ok, inviteId, inviteUrl, role, expiresAt, emailed }`

### 2. `POST /portal-invite-accept` — grant access (invitee, after magic-link login)
Body: `{ token }`
- Validates token (unused, unexpired) + **identity binding** (verified email/phone must
  match the invite target).
- Upserts `portal_users`, mints `portal_access` (visibility = role). Single-use.
- → `{ ok, loanFileId, role }`

### 3. `POST /portal-doc-upload-url` — signed upload URL (borrower/co-borrower only)
Body: `{ loanFileId, docKey }`
- Rejects realtors (`canSeeFinancials=false`). Validates `docKey` against the file's
  checklist. Server-controlled path in the **private** `ourmtg-docs` bucket.
- Upserts the `loan_documents` row (status `requested`).
- → `{ ok, documentId, bucket, path, uploadUrl, token }`
- Client then: `supabase.storage.from('ourmtg-docs').uploadToSignedUrl(path, token, file)`.

### 4. `POST /portal-doc-complete` — finalize an upload (borrower/co-borrower)
Body: `{ documentId }`
- Verifies the object exists in storage, flips `loan_documents.status='uploaded'`,
  logs a `loan_messages` timeline entry, **emails the LO**, and **confirms to the borrower**.
- → `{ ok, documentId, status:'uploaded' }`

### 5. `GET /portal-status?loanFileId=<id>` — status tracker (read-only)
- borrower/owner → stage + 7-step tracker + "what's next" + loan type/purpose + amount + est close.
- realtor → **milestone only**: coarse milestone, est close, LO-published pre-approval band.
  No amount, rate, documents, or conditions.

### 6. `GET /portal-checklist?loanFileId=<id>` — document checklist
- borrower/owner only (realtor → 403). Required docs (by loan type/purpose) joined with
  uploaded/missing status + friendly labels.
- **owner** view additionally includes the separated `internalNote` per item; the
  borrower view never sees internal notes.

### 7. `POST /portal-doc-review` — accept/reject an uploaded document (LO/owner)
Body: `{ documentId, decision: 'accepted'|'rejected', rejectReason? }`
- Owner-only. Only fires from `status='uploaded'` (guarded update + row-count check —
  a lost race reports 409, never a double notification). Rejecting requires a reason.
- Rejection **emails the borrower/co-borrower** (actionable — re-upload needed).
  Acceptance is silent-by-design (visible in-portal) to avoid per-doc email noise.
  Re-upload after rejection reuses `portal-doc-upload-url` unchanged.
- → `{ ok, documentId, status }`

### 8. `POST /portal-preapproval-set` — issue/clear pre-approval (LO/owner)
Body: `{ loanFileId, amount, expires }` (`amount`: positive number or `null` to clear;
`expires`: `'YYYY-MM-DD'`, `null` to clear, or omit to leave unchanged)
- Owner-only. The **only** writer of `loan_files.preapproval_*` — the projector
  (`sync-loan-file.mjs`) deliberately never touches these fields, so Realtor exposure
  is always a deliberate human action, never an automatic sync.
- Best-effort **emails any Realtor(s)** already granted `portal_access` to the file.
- → `{ ok, loanFileId, preapprovalAmount, preapprovalExpires }`

### 9. `GET /portal-review-queue` — LO queue (read-only, owner-scoped)
- Every loan file the caller owns, with `missingDocs`, `pendingReview` (uploaded docs
  awaiting accept/reject), `openConditions`, `lastActivity`, a simple `stuck` flag
  (missing docs + no activity for 72h+), and a one-line `nextAction`. Data endpoint for
  the future LO dashboard — no UI. Reads `loan_files`/`loan_documents`/`loan_conditions`/
  `loan_messages` only, never `app_state`.

## Security model (why this is safe)
- **Two layers.** RLS (migration 036) protects any direct client query; the gateway adds
  explicit `portal_access` checks in code (`resolveAccess` / `canSeeFinancials`).
- **Realtors are structurally blocked** from documents, conditions, and financial status —
  in the RLS policy *and* in every endpoint.
- **Private bucket only.** Financial docs live in `ourmtg-docs` (`public=false`); access is
  server-minted signed URLs on server-controlled paths. `crm-media` is never used.
- **Identity binding** on invite accept prevents a leaked link being redeemed by another user.
- **Audit.** Every action writes `portal_access_log`.

## Design note — "create a GRCRM task on upload"
The brief listed *"create/update task in GRCRM if available."* We deliberately **do not**
write to `app_state` (`wcci-tasks`) — the standing guardrail is *never write borrower data
back into app_state*. The LO review queue is instead `loan_documents WHERE status='uploaded'`
(surfaced by the upload-complete email now, and the LO dashboard later). If a real
`wcci-tasks` entry is wanted, add it behind an explicit opt-in env flag — say the word.

## Not built yet (per scope)
No UI, no WCCI calls, no new CRM, no `app_state` writes. Next: borrower app screens
(status tracker + checklist/upload) and the LO invite/review UI.
