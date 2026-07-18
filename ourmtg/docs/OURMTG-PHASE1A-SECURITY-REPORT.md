# OURMTG — Phase 1A Security Report (authoritative)

**Repository:** `westccmortgage/Ourmtg`
**Branch:** `claude/ourmtg-phase1a-security-foundation`
**Base commit:** `84b1d30` (Phase 0 rebase `aa221f9` is an ancestor)
**Scope:** security & operational hardening of the existing app. No new production loan-ops/AI/task/event/disclosure/vendor tables. No migrations applied. No deploy/merge. No production env changes. Approved stack unchanged (Vite/React/Netlify/Supabase). Existing UI/routes/workflows preserved.

Supersedes the interim `OURMTG-PHASE1A-HARDENING.md` (which used the old `CRON_SECRET`/opt-in scheme).

---

## 1. Findings & remediation

| ID | Finding | Severity | Exact files | Remediation |
|---|---|---|---|---|
| **A** | **Global site-settings writable via loan ownership.** `portal-settings-set` allowed writes to the publicly-read `site_settings` if the caller owned ≥1 loan file — and any authed user can self-provision ownership (`portal-loanfile-set`). | **High** | `netlify/functions/portal-settings-set.mjs`, `_lib/portal.mjs` | Centralized `isSettingsAdmin(email, OURMTG_ADMIN_EMAILS)` — allowlist-only, normalized, **fail-closed**, identity from the verified JWT only (never a body email). Ownership path removed. Audited: `site_settings` is the sole platform-global write. |
| **B** | **Cron authorized by a spoofable platform header.** `sync-loan-file` trusted `x-netlify-event`. | **Medium** | `_lib/cronGuard.mjs`, `sync-loan-file.mjs` | Sole authorization is now `OURMTG_CRON_SECRET` presented as `Authorization: Bearer <secret>`, **constant-time** compared, **fail-closed** if unset, never read from query, never logged. Netlify header retained as diagnostic **context only** — it never authorizes. |
| **C** | **No abuse protection on the public `lead-submit`.** | **Medium** | `lead-submit.mjs`, `_lib/ratelimit.mjs`, `_lib/validation.mjs` | JSON-only content-type check, method allowlist, 20 KB size cap, honeypot, and a rate limit keyed by a **privacy-conscious salted fingerprint** (no raw IP persisted for rate limiting). Email/phone normalized + validated. Public errors are generic; upstream detail logged server-side only. |
| **D** | **Weak upload type controls / path-traversal surface.** | **Medium** | `_lib/upload-policy.mjs`, `_lib/portal.mjs` (`storageDocPath`), `portal-doc-upload-url.mjs` | Traversal-safe server-controlled path builder. New declared-type allowlist (PDF/JPEG/PNG/HEIC), dangerous/double-extension rejection (HTML/SVG/exe), filename normalization. `portal-doc-upload-url` validates `contentType`/`filename` when provided (backward compatible). **Not** content sniffing / malware scanning — see risk 7.4. |
| **E** | **SMTP/CRLF header-injection surface + vulnerable `nodemailer`.** User-influenced `to`/`subject`/`replyTo` reached nodemailer (≤9 has HIGH advisories). | **Medium/High** | `_lib/mailer.mjs` | `sanitizeHeader()` strips CR/LF/control chars from all header-bound fields (version-independent injection defense). **The nodemailer upgrade is still required** — see risk 7.1 (not claimed as fixed). |
| **F** | **No cache controls on sensitive API responses; missing security headers.** | **Medium** | `_lib/portal.mjs`, `lead-submit.mjs`, root `netlify.toml` | `Cache-Control: no-store` on all portal/lead responses. CSP + `X-Content-Type-Options` + `X-Frame-Options` + `Referrer-Policy` + `Permissions-Policy` + HSTS added; static assets long-cached. See `OURMTG-SECURITY-HEADERS.md`. |
| **G** | **PII/secret logging risk; leaky error text.** | **Low/Medium** | `_lib/safelog.mjs`, `lead-submit.mjs` | Redacting `safelog` helper + generic public errors + documented redaction policy (`OURMTG-REDACTION-POLICY.md`). |
| **H** | **Stale "OWNER only" comments** vs `isInternal` (owner or team). | **Low** | `portal-invite-create.mjs`, `portal-preapproval-set.mjs` | Comments corrected to describe actual behavior. No authorization change. |
| **I** | **Runbook drift** (039, `cron_heartbeat`, env names). | **Medium** | `docs/OURMTG_DEPLOY.md`, `.env.example` | Reconciled to 036–039; `cron_heartbeat` verification (confirmed **not** created by 036–039; guarded draft `042` for manual apply); new env vars documented. |

Access model for borrower / co-borrower / realtor / escrow / title / loan-team is **unchanged** (owner directive #2). The only authorization tightened is platform-admin (settings) and cron.

---

## 2. Authorization matrix

Full per-endpoint matrix + classification + global-write audit + webhook inventory: **`OURMTG-ENDPOINT-AUTHORIZATION-MATRIX.md`**. Summary:
- **public:** `lead-submit` (now rate-limited + validated).
- **cron-only:** `sync-loan-file` (Bearer secret).
- **internal/admin-only:** `portal-settings-set` (admin allowlist).
- **authenticated:** the 15 `portal-*` endpoints, each gated by `resolveAccess` → `isInternal`/`canSeeFinancials`.
- **webhook-only:** none exist today (Arive not integrated this phase).

---

## 3. Authentication & role review (§6)

Verified server-side (frontend route protection is **not** treated as security):
- JWT verified via `_lib/userauth.getUser` (anon key) on every `portal-*` call; service-role work then gated in code.
- `resolveAccess` decisions unit-tested with an injected fake Supabase client (`tests/access.test.mjs`): owner short-circuit, team membership, portal grant, **no-grant → null** (a stranger or a borrower of another file cannot resolve access to a file they lack a grant for — a guessed loan-file id does not bypass authorization), `42P01` graceful degradation, null file.
- `canSeeFinancials` keeps realtor/escrow/title out of documents/conditions/financial status; `isInternal` keeps portal grantees out of review/invite/preapproval/team endpoints. UI role switching (`?as=`) changes only the rendered view — every server endpoint re-derives authority from the JWT + grants.
- Signed uploads: authorized file + allowlisted doc-key + server-controlled traversal-safe path; download URLs are 300 s and internal-only.

---

## 4. Tests added

Runner: Node built-in `node:test` (zero new runtime deps). Mocks/pure helpers only — **no** call to production Supabase, email, storage, or any external service. Totals: **59 tests / 59 pass / 0 fail**.

| Suite | Covers |
|---|---|
| `tests/authz.test.mjs` (14) | Blocker A — the 10 admin cases (no/malformed JWT, borrower, realtor, non-admin owner, non-admin team, admin, missing var fail-closed, case/whitespace, spoofed-body-email ignored) + `canSeeFinancials`/`isInternal`/`storageDocPath`/`isValidDocKey` |
| `tests/cron.test.mjs` (10) | Blocker B — the 7 cases (no header, wrong scheme, wrong secret, correct secret, missing server secret fail-closed, spoofed platform header denied, secret never in output) + Bearer parse + constant-time |
| `tests/ratelimit.test.mjs` (5) | Blocker C — limiter allow/block/reset, key independence, **fingerprint deterministic + no raw IP**, size cap, honeypot |
| `tests/validation.test.mjs` (5) | content-type, email/phone normalize + validate (malformed rejected) |
| `tests/upload.test.mjs` (4) | MIME allowlist, dangerous/double extension, filename normalize, `validateUpload` |
| `tests/access.test.mjs` (8) | role authorization via injected fake svc (cross-borrower isolation, guessed id, team/owner/portal/none) |
| `tests/safelog.test.mjs` (4) | key/value redaction, signed-URL/JWT masking, generic public error |
| `tests/mailer.test.mjs` (4) | CRLF/control-char header sanitization (single + array), length cap, `esc` |
| `src/domain/*.test.js` (5) | Phase 0 domain contracts (flags off, vocab, contracts) |

CI (`.github/workflows/ci.yml`): `npm ci` → `npm run check` → `npm run test:domain` → `npm run test:security` → `npm run build` on Node 22, working dir `ourmtg/`.

---

## 5. Commands & results (from `ourmtg/`)

| Command | Result |
|---|---|
| `npm ci` | installs cleanly (Node 22) |
| `npm run check` | **ok** — all handlers + libs pass `node --check` |
| `npm run test:domain` | 5 pass / 0 fail |
| `npm run test:security` | 54 pass / 0 fail |
| `npm test` (both) | **59 pass / 0 fail** |
| `npm run build` | **success** — 185 modules, JS 554.20 kB (gzip 169.26 kB); Vite >500 kB chunk **warning only** (not a security control) |
| `npm audit` | **3 vulnerabilities (1 moderate, 2 high)** — see risk 7.1. Not auto-fixed (breaking major bumps); reported honestly, not silenced. |

---

## 6. Migration impact

**None.** No migration applied or created in `supabase/migrations/`. Guarded, non-runnable drafts `040`/`041`/`042` are untouched except doc clarification. `cron_heartbeat` confirmed absent from 036–039; the projector's heartbeat is fail-soft, and `042` (guarded) exists to add it manually if verification shows it missing.

---

## 7. Remaining security risks

1. **`nodemailer` ≤9 HIGH advisories (npm audit).** `sanitizeHeader` mitigates the CRLF/header-injection vector **in our code**, but the dependency itself should be upgraded to `nodemailer@^9` in a focused follow-up (review `_lib/mailer.mjs` SMTP usage after the bump). This is **not** claimed as resolved.
2. **`vite`/`esbuild` moderate/high advisories** are **dev-server-only** (build tooling), not shipped to production. Upgrading `vite` is a major bump; deferred to avoid regression churn in a security phase.
3. **Rate limiter is best-effort / in-process.** It throttles bursts on a warm instance but is **not** cross-instance consistent; it does not claim to be. A durable limiter needs a shared store (Postgres/Upstash) — deferred (no new production tables this phase; no unreviewed vendor).
4. **No content sniffing / malware scanning of uploads.** Type checks are declared-type + filename hygiene only. `_lib/scan-provider.mjs` is an **inert** interface (always `unscanned`) documenting the future requirement — no fake scanner. True enforcement (magic-byte sniffing + AV) is a future phase.
5. **Cron operational change at deploy.** After deploy the projector **fail-closes** unless `OURMTG_CRON_SECRET` is set and the scheduler sends the Bearer header. Not yet applied (no prod env change this phase).
6. **CSP allows `'unsafe-inline'` for styles** (React inline `style={{}}`). Scripts remain strict (`'self'`). Removing inline styles to tighten `style-src` is future work.
7. **Tenancy still `owner_user_id`-only.** Not changed this phase. The first real operational migrations must add an explicit `organization_id` boundary (`OURMTG-TARGET-DATA-MODEL.md` Part E) — future requirement, documented, not implemented.
8. **Consent ledger retains raw IP** by design (TCPA compliance) — intentional, documented in the redaction policy; distinct from rate-limit data.

---

## 8. Deployment prerequisites (env — set at deploy, NOT changed by this phase)

| Var | Required? | Purpose |
|---|---|---|
| `OURMTG_ADMIN_EMAILS` | **required** for settings admin | comma-separated allowlist; empty = no one can edit `site_settings` |
| `OURMTG_CRON_SECRET` | **required** for the projector | Bearer secret; scheduler sends `Authorization: Bearer <secret>`; unset = projector 403s |
| `OURMTG_FINGERPRINT_SALT` | optional | salts the rate-limit fingerprint (per deploy) |
| `LEAD_RATE_MAX` / `LEAD_RATE_WINDOW_MS` | optional | rate-limit tuning (default 5 / 60000) |
| existing | — | `SUPABASE_URL/ANON_KEY/SERVICE_ROLE`, `VITE_SUPABASE_*`, `LEAD_INBOUND_URL/TOKEN`, `RESEND_PLATFORM_KEY`, `OURMTG_URL`, `MAIL_FROM` |

Also verify migrations 036–039 applied and whether `cron_heartbeat` exists (`OURMTG_DEPLOY.md` §1). Configure an authenticated scheduler for `sync-loan-file` with the Bearer secret.

**Emergency disable:** to stop the projector, unset `OURMTG_CRON_SECRET` (it fail-closes). To stop public intake, unset `LEAD_INBOUND_URL`/`LEAD_INBOUND_TOKEN` (returns 503) or set `LEAD_RATE_MAX=0`-style throttle. To lock down settings, clear `OURMTG_ADMIN_EMAILS` (no one can write).

---

## 9. Rollback procedure

All changes are additive code/config/docs + tests. Nothing deployed or migrated.
- **Full:** `git revert <phase-1a-commit>` or reset the branch to base `84b1d30`. No DB/env state to undo.
- **Selective:**
  - *Admin authz:* revert `portal-settings-set.mjs` + the `isSettingsAdmin` block in `_lib/portal.mjs`.
  - *Cron:* revert `_lib/cronGuard.mjs` + `sync-loan-file.mjs`. (Operationally, correct config is safer than reverting.)
  - *Public abuse:* revert `lead-submit.mjs`; delete `_lib/ratelimit.mjs`/`_lib/validation.mjs`. Or set `LEAD_RATE_MAX` very high (limiter fails open on error).
  - *Uploads:* revert `portal-doc-upload-url.mjs`; delete `_lib/upload-policy.mjs` (`storageDocPath` is already used elsewhere — keep it).
  - *Headers:* revert the `[[headers]]` blocks in `netlify.toml`.
  - *Mailer:* revert `_lib/mailer.mjs` (removes header sanitization — not recommended).
  - *CI/tests/docs:* delete `.github/workflows/ci.yml`, `tests/`, and the added docs — no runtime impact.
- **Migrations:** none applied; nothing to roll back. Drafts stay guarded.

---

## 10. Recommended Phase 1B prompt outline

```
OURMTG — PHASE 1B  (dependency & durability hardening; still no new product tables)

Preconditions: start from claude/ourmtg-phase1a-security-foundation. Do not deploy/merge/
apply migrations or change prod env. Preserve all Phase 0/1A work, stack unchanged.

1. Dependency remediation (from Phase 1A npm audit):
   - Upgrade nodemailer to ^9; review/adjust _lib/mailer.mjs SMTP usage; keep sanitizeHeader.
   - Evaluate vite/esbuild upgrade (dev-only advisories) in an isolated branch; confirm build.
   - Re-run npm audit; document residual advisories honestly.
2. Durable, cross-instance rate limiting for public endpoints:
   - Decide store (Supabase table w/ short TTL + cleanup, or an approved managed KV).
   - If a table is chosen, author it WITH an explicit organization_id boundary (Target-Data-Model
     Part E) as the first real operational migration — draft only unless owner approves applying.
   - Keep raw IP unstored (store only the salted fingerprint); document retention.
3. Upload content verification:
   - Add magic-byte/content sniffing to back the declared-type allowlist.
   - Wire the inert ScanProvider to a real AV/scan step OR formally accept the risk with sign-off.
4. Logging adoption:
   - Migrate remaining console.* to safelog.logEvent with request IDs; verify no PII/secret leakage.
5. CSP tightening:
   - Remove inline styles where practical to drop style-src 'unsafe-inline'; add report-only CSP first.
6. Tests + CI: extend coverage for the above; keep npm test green; no external calls in tests.

Deliver: findings, files, tests, npm audit before/after, migration impact (drafts only),
remaining risks, rollback. Stop after 1B.
```
