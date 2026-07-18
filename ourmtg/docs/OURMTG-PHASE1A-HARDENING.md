# OURMTG — Phase 1A: Security & Operational Hardening (delivery record)

> **⚠️ SUPERSEDED.** This file records an interim hardening pass on branch
> `claude/ourmtg-ai-operations-phase0-rebase`. The authoritative Phase 1A deliverable is
> **`OURMTG-PHASE1A-SECURITY-REPORT.md`** on branch `claude/ourmtg-phase1a-security-foundation`.
> Notably, the cron secret was renamed to **`OURMTG_CRON_SECRET`** and moved to an
> `Authorization: Bearer` scheme (the `CRON_SECRET` / `CRON_ALLOW_NETLIFY_SCHEDULE` names below
> are from this interim pass and no longer exist). Read the security report for current state.

**Repo:** `westccmortgage/Ourmtg` · **Branch:** `claude/ourmtg-ai-operations-phase0-rebase`
**Approved stack:** Vite · React · Netlify · Supabase (no Next.js/Vercel migration).
**Scope:** hardening only — no new domain tables, no migrations applied, no deploy/merge, no prod env change, existing UI/workflows preserved.

---

## 1. Vulnerabilities / weaknesses fixed

| ID | Severity | Issue | Fix |
|---|---|---|---|
| **R1** | High | **Privilege escalation:** `site_settings` (global, publicly-read: live rate + homepage copy) was writable by anyone who "owns ≥1 loan file" — and any authenticated user can self-provision ownership via `portal-loanfile-set`. | `portal-settings-set.mjs` now authorizes **only** the explicit `OURMTG_ADMIN_EMAILS` allowlist (pure `isSettingsAdmin`). The ownership path is removed; empty allowlist = no one (fail-closed). |
| **R2** | Medium | **Cron header-trust:** `sync-loan-file` treated the presence of `x-netlify-event` as proof of a genuine scheduled run — spoofable if the platform edge behavior changes. | New `authorizeCron` requires a **verified `CRON_SECRET`** (constant-time compare) by default. Netlify's schedule header is honored **only** when `CRON_ALLOW_NETLIFY_SCHEDULE=true` is explicitly set. |
| **R3** | Medium | **No abuse protection** on the public `lead-submit` endpoint. | Per-IP best-effort **rate limit** (429 + `retry-after`), **raw payload-size cap** (20 KB), and a **honeypot** field. Fail-open if the limiter itself errors, so legitimate borrowers are never blocked. |
| **R4** | Low | **Misleading authz comments** ("OWNER only") on `portal-invite-create` / `portal-preapproval-set` while code allows owner **or** team. | Comments corrected to state `isInternal` (owner or team). No behavior change. |
| **R6** | Medium | **Runbook drift:** migration 039 + `cron_heartbeat` unlisted; deploy verification stale. | `OURMTG_DEPLOY.md` updated (036–039, site_settings + cron_heartbeat checks, new env). `cron_heartbeat` confirmed **not** created by 036–039; guarded draft `042` provided for manual apply if missing. |

Preserved (owner decision #2 — access model unchanged): borrower / co-borrower / realtor / escrow / title / loan-team access is untouched. The only authorization tightened is **platform-admin** (site settings), which is deliberately distinct from loan-file access.

---

## 2. Exact files changed

**Functions (behavior):**
- `netlify/functions/_lib/portal.mjs` — added pure `parseAdminEmails`, `isSettingsAdmin`, `storageDocPath` (path-traversal-safe).
- `netlify/functions/portal-settings-set.mjs` — admin-allowlist-only authorization; removed the owns-a-file fallback + DB lookup.
- `netlify/functions/_lib/cronGuard.mjs` — rewritten: `authorizeCron`, `timingSafeEqualStr`, `hasNetlifyScheduleSignal`; `isScheduledInvocation` kept as a wrapper.
- `netlify/functions/sync-loan-file.mjs` — uses `authorizeCron`; logs rejection reason.
- `netlify/functions/_lib/ratelimit.mjs` — **new** pure limiter + honeypot + payload-size helpers.
- `netlify/functions/lead-submit.mjs` — rate limit + size cap + honeypot; `json()` accepts extra headers.
- `netlify/functions/portal-invite-create.mjs`, `portal-preapproval-set.mjs` — corrected authz comments.

**Tests / CI (new):**
- `tests/authz.test.mjs`, `tests/cron.test.mjs`, `tests/ratelimit.test.mjs`
- `.github/workflows/ci.yml` — `npm ci && check && test && build` on Node 22, base `ourmtg/`.
- `package.json` — added `test` (and kept `test:domain`).

**Docs / config:**
- `docs/OURMTG_DEPLOY.md` — migrations 036–039, cron_heartbeat + site_settings verification, new env vars, cron note.
- `.env.example` — `OURMTG_ADMIN_EMAILS`, `CRON_SECRET`, `CRON_ALLOW_NETLIFY_SCHEDULE`, `LEAD_RATE_*`.
- `docs/OURMTG-TARGET-DATA-MODEL.md` — Part E: mandatory `organization_id` boundary for the first real operational migrations.
- `docs/phase0/draft-migrations/042_cron_heartbeat.DRAFT.sql` — **new**, guarded non-runnable.
- `docs/phase0/draft-migrations/README.md` — 042 row + org_id directive.

No production table was created or altered. Drafts 040/041/042 remain guarded and outside `supabase/migrations/`.

---

## 3. Tests added (26 total, `node --test`, zero new deps)

- **`tests/authz.test.mjs`** — `canSeeFinancials` (realtor/escrow/title excluded), `isInternal` (owner/team vs portal/null), `parseAdminEmails`, `isSettingsAdmin` (allowlist-only, case-insensitive, fail-closed), `storageDocPath` (owner-rooted, traversal-sanitized), `isValidDocKey` (real slots vs arbitrary; purpose/type shaping; Non-QM drops wage docs).
- **`tests/cron.test.mjs`** — `authorizeCron` secret match / bad secret / not-presented / no-secret misconfig / **header alone denied** / opt-in accepted / query-param secret; `timingSafeEqualStr`; `hasNetlifyScheduleSignal`.
- **`tests/ratelimit.test.mjs`** — allow-up-to-max then block, independent keys, window reset, `validatePublicPayload` (empty/oversized/normal), honeypot, `clientKey` extraction.
- Existing `src/domain/*.test.js` (5) still run under `npm test`.

---

## 4. Authorization matrix (current, after Phase 1A)

| Action / endpoint | Anonymous | Borrower / co-borrower | Realtor / escrow / title | Loan team (processor/assistant) | Owner (LO) | Platform admin |
|---|---|---|---|---|---|---|
| Public funnel, `lead-submit` | ✅ (rate-limited) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sign in (magic link) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Accept invite (identity-bound) | — | ✅ | ✅ | — | — | — |
| Read own status/checklist/docs | — | ✅ | ❌ financials (milestone-only status) | ✅ | ✅ | ✅ |
| Signed **upload** URL / complete | — | ✅ | ❌ | ✅ | ✅ | ✅ |
| Doc **review** (accept/reject) | — | ❌ | ❌ | ✅ | ✅ | ✅ |
| Request doc / set condition / message | — | ❌ (message: ✅) | ❌ | ✅ | ✅ | ✅ |
| Set pre-approval band | — | ❌ | ❌ | ✅ (`isInternal`) | ✅ | ✅ |
| Create invite | — | ❌ | ❌ | ✅ (`isInternal`) | ✅ | ✅ |
| Review queue / file detail | — | ❌ | ❌ | ✅ | ✅ | ✅ |
| Manage team (`portal-team-set`) | — | ❌ | ❌ | ❌ (owner-only) | ✅ | ✅ |
| Create/update loan file | — | create: any authed user; update: `isInternal` | update ❌ | ✅ | ✅ | ✅ |
| **Write `site_settings`** | ❌ | ❌ | ❌ | ❌ | ❌ (unless in allowlist) | ✅ **allowlist only** |
| Cron projector `sync-loan-file` | ❌ | ❌ | ❌ | ❌ | ❌ | verified `CRON_SECRET` (or opt-in schedule) |

Enforcement primitives (unchanged, reused everywhere): `resolveAccess` → `isInternal` / `canSeeFinancials`; realtor/escrow/title blocked from financials in **both** RLS and code. Bold cells are the Phase 1A tightenings.

---

## 5. Endpoint protection report

| Endpoint | Auth | Abuse / integrity controls |
|---|---|---|
| `lead-submit` (public) | none by design | **per-IP rate limit (429), 20 KB size cap, honeypot**, name + email/phone required, consent ledger fail-soft, no `app_state` writes |
| `portal-settings-set` | JWT | **admin allowlist only** (fail-closed), input clamped (rate 0–25, string caps), audit row |
| `sync-loan-file` (cron) | **verified `CRON_SECRET`** (constant-time) or explicit schedule opt-in | idempotent upsert, time-boxed, reads `app_state` only, never writes `preapproval_*`, heartbeat |
| `portal-doc-upload-url` | JWT + `canSeeFinancials` | **server-controlled, traversal-safe path** (`storageDocPath`), docKey allowlisted, private bucket only |
| `portal-doc-complete` | JWT + `canSeeFinancials` | verifies object exists before status flip |
| `portal-doc-review` | JWT + `isInternal` | race-safe guarded update, reason required on reject |
| `portal-invite-create/accept` | JWT (+ identity binding on accept) | 32-hex token, single-use, expiry clamp |
| all `portal-*` | JWT via anon-key verify | service-role work gated by `resolveAccess`; audit via `portal_access_log` |

---

## 6. Commands run & results (from `ourmtg/`)

- `npm run check` → **ok** (all handlers + libs `node --check`).
- `npm test` → **# tests 26 / # pass 26 / # fail 0** (authz 6, cron 9, ratelimit 6, domain 5).
- `npm run build` → **success** (185 modules; JS 554 kB gzip ~169 kB; Vite chunk-size warning only).

CI (`.github/workflows/ci.yml`) runs the same three on every push/PR (Node 22).

---

## 7. Remaining risks (honest)

1. **Rate limiter is in-process / best-effort.** It throttles bursts on a warm instance but is not globally consistent across cold starts or multiple instances. A durable limiter needs a shared store (Postgres/Upstash) — deferred because Phase 1A must not add production tables. Front with a Netlify/edge rate limit for stronger guarantees.
2. **Cron operational change required at deploy.** After deploy, the projector 403s unless `CRON_SECRET` is set (with an authenticated trigger) or `CRON_ALLOW_NETLIFY_SCHEDULE=true`. Documented in the runbook; not yet applied (no prod env change this phase).
3. **`cron_heartbeat` may be absent** in the shared project. The heartbeat write is fail-soft, but the "LO dashboard empty" diagnostic depends on it — apply draft `042` if the verification query returns 0.
4. **Tenancy is still `owner_user_id`-only.** Not changed this phase (per decision #7/#9). The `organization_id` boundary is mandated for the first real operational migrations (target-model Part E).
5. **No email delivery tracking yet** (Phase 2, `notification_deliveries`). Emails remain fail-soft/silent.
6. **npm audit** reports advisories in the dependency tree (build tooling); not addressed here to avoid dependency churn in a security-hardening phase.

---

## 8. Rollback instructions

All changes are additive code/config + docs; nothing was deployed or migrated.

- **Full rollback:** `git revert <phase-1a-commit>` (or reset the branch to the prior Phase 0 commit `aa221f9`). No database or environment state to undo.
- **Selective rollback:**
  - *Settings authz:* revert `portal-settings-set.mjs` + the `isSettingsAdmin` block in `_lib/portal.mjs`.
  - *Cron:* revert `_lib/cronGuard.mjs` + `sync-loan-file.mjs` (restores header-trust). Operationally, unsetting `CRON_SECRET` with `CRON_ALLOW_NETLIFY_SCHEDULE=true` reproduces prior behavior without a code change.
  - *Rate limiting:* revert `lead-submit.mjs` + delete `_lib/ratelimit.mjs`. Or neutralize live via `LEAD_RATE_MAX` set very high (limiter fails open on error).
  - *CI/tests:* delete `.github/workflows/ci.yml`, `tests/`, and the `test` script — no runtime impact.
- **No migration rollback needed:** drafts 040/041/042 were never applied (guarded, outside `supabase/migrations/`).
- **Env vars:** none were changed in production. New vars (`OURMTG_ADMIN_EMAILS`, `CRON_SECRET`, `CRON_ALLOW_NETLIFY_SCHEDULE`, `LEAD_RATE_*`) take effect only when the owner sets them at deploy time.
