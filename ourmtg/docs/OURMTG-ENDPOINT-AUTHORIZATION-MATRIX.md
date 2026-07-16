# OURMTG — Endpoint Authorization Matrix

**Branch:** `claude/ourmtg-phase1a-security-foundation` · **Scope:** all Netlify Functions in `ourmtg/netlify/functions/`.

Classification legend: **public** (unauthenticated by design) · **authenticated** (Supabase JWT) · **cron-only** (scheduled secret) · **webhook-only** (provider callback) · **internal/admin-only** (platform admin).

Enforcement primitives (server-side, `_lib/portal.mjs`): `authUser` (verify JWT via anon key) → `resolveAccess` (owner / team / portal grant) → `isInternal` (owner|team) / `canSeeFinancials` (owner|borrower|coborrower). Realtor/escrow/title are structurally blocked from financial data in **both** RLS (036/038) and code. All portal responses set `Cache-Control: no-store`.

| Function | Class | Allowed actor | AuthN | AuthZ | Rate limit | Sensitive data | Side effects | Idempotent | Current risk | Phase 1A change |
|---|---|---|---|---|---|---|---|---|---|---|
| `lead-submit` | **public** | anyone (pre-signup) | none | none | **yes — fingerprint** | name/email/phone, consent text, IP (consent ledger) | forwards to GRCRM `lead-inbound`; writes `portal_consent` | no (new lead per call; honeypot+limit mitigate) | abuse/spam (mitigated) | **content-type + size + honeypot + fingerprint rate limit + email/phone normalize/validate + generic errors + no-store** |
| `sync-loan-file` | **cron-only** | scheduler | `OURMTG_CRON_SECRET` Bearer (constant-time) | n/a (system) | n/a | reads GRCRM `app_state` | upserts `loan_files`; `cron_heartbeat` | **yes** (upsert) | header-trust (fixed) | **Bearer-secret sole auth; fail-closed; header no longer authorizes** |
| `portal-settings-set` | **internal/admin-only** | platform admin | JWT | **`OURMTG_ADMIN_EMAILS` allowlist only** | inherited | site-wide rate/programs/copy | writes `site_settings` | yes (upsert) | **escalation (fixed)** | **removed ownership path; allowlist-only; no-store** |
| `portal-invite-create` | authenticated | owner/team | JWT | `isInternal` | — | invite token, email | writes `portal_invites`; email | no (new invite) | low | comment fix; sanitized email headers; no-store |
| `portal-invite-accept` | authenticated | invitee | JWT + **identity binding** | token valid+unused+unexpired; verified email/phone must match | — | grants access | writes `portal_users`+`portal_access` | **yes** (single-use) | low | no-store |
| `portal-status` | authenticated | grantee | JWT | `resolveAccess`; column-scoped by visibility | — | borrower financials / realtor milestone | read-only | yes | low | no-store |
| `portal-checklist` | authenticated | borrower/coborrower/owner | JWT | `canSeeFinancials` (realtor 403); internal note gated | — | doc checklist + LO notes | read-only | yes | low | no-store |
| `portal-doc-upload-url` | authenticated | borrower/coborrower/owner | JWT | `canSeeFinancials` | — | doc slot, signed upload URL | upserts `loan_documents` | yes (per slot) | medium | **traversal-safe path builder + optional MIME/ext validation + no-store** |
| `portal-doc-complete` | authenticated | borrower/coborrower/owner | JWT | `canSeeFinancials` | — | document object | flips status; email | yes (verifies object) | low | no-store |
| `portal-doc-review` | authenticated | owner/team | JWT | `isInternal` | — | document decision | guarded update; email | **yes** (row-count guard) | low | no-store |
| `portal-doc-request` | authenticated | owner/team | JWT | `isInternal` | — | requested doc | writes `loan_documents`; email | no | low | sanitized email headers; no-store |
| `portal-condition-set` | authenticated | owner/team | JWT | `isInternal` | — | UW conditions | writes `loan_conditions` | yes (id+file scoped) | low | no-store |
| `portal-preapproval-set` | authenticated | owner/team | JWT | `isInternal` | — | preapproval band (realtor-visible) | writes `loan_files.preapproval_*`; email | yes | low | comment fix; sanitized headers; no-store |
| `portal-message-send` | authenticated | internal or borrower/coborrower | JWT | access + (`isInternal` \|\| `canSeeFinancials`) | — | message body | writes `loan_messages`; email | no | low | sanitized headers; no-store |
| `portal-loanfile-set` | authenticated | create: any authed; update: owner/team | JWT | create → caller becomes owner; update → `isInternal` | — | loan file fields | writes `loan_files` | yes (update) | note: self-provisioned ownership (see report) | no-store |
| `portal-review-queue` | authenticated | owner/team | JWT | owner + teams caller belongs to | — | pipeline aggregates | read-only | yes | low | no-store |
| `portal-file-detail` | authenticated | owner/team | JWT | `isInternal` | — | full file + signed download URLs (300s) | read-only | yes | low | no-store |
| `portal-team-set` | authenticated | owner only | JWT | `owner_user_id === caller` | — | team membership | writes `portal_team` | yes | low | no-store |

## Global-write endpoint audit (Blocker A)

The only **platform-global** write is `portal-settings-set` (the singleton `site_settings` row read publicly by every visitor). It is now gated by `isSettingsAdmin(email, OURMTG_ADMIN_EMAILS)` — allowlist-only, fail-closed, identity from the verified JWT (never a body-supplied email). No other endpoint writes global/tenant-shared state: every other write is scoped to a specific `loan_file` (owner/team/grant) or the caller's own team. `portal-loanfile-set` create lets any authed user create a file they own — that is per-file, not global, but it is why the settings ownership path was an escalation and was removed.

## Webhook inventory (§8)

**There are no inbound provider webhook endpoints in this codebase today.** Nothing here receives signed callbacks from a third party.
- `lead-submit` is an **outbound** proxy (OurMTG → GRCRM `lead-inbound`); it originates a request with a server-side token, it does not receive one.
- `sync-loan-file` is a **scheduled** job (now Bearer-secret authorized), not a provider webhook.
- Arive (future LOS source of record) is **not** integrated in this phase — no Arive callback endpoint exists or is claimed.

If/when a real inbound webhook is added (future phase), it must implement: signature validation over the **raw** body (before JSON parse), a timestamp-tolerance replay window, per-event idempotency, an event-type allowlist, sanitized logging, and safe unknown-event handling. No such endpoint is added in Phase 1A; no vendor integration is introduced.
