# OURMTG — Logging & Redaction Policy (Phase 1A §9)

Applies to all Netlify Functions. Helper: `_lib/safelog.mjs` (`logEvent`, `redact`, `publicError`).

## Never log (server logs or responses)
- Secrets: `OURMTG_CRON_SECRET`, `SUPABASE_SERVICE_ROLE`, `LEAD_INBOUND_TOKEN`, `RESEND_PLATFORM_KEY`, any API key.
- Credentials in transit: full JWTs / Bearer tokens (Authorization header), Supabase signed-URL tokens/signatures.
- Raw request bodies and document contents.
- Unnecessary borrower PII: name, email, phone, property address, document filenames — beyond what a specific audit record legitimately needs.
- Stack traces in **public responses** (allowed only in controlled server logs).

## Never return to clients
- Internal error detail, upstream error text, stack traces, table/column names. Public errors are **generic** (`publicError()`), optionally with a `requestId` the user can quote to support.

## Redaction mechanics (`redact`)
- Object keys matching `authorization|token|secret|password|jwt|cookie|signed_url|service_role|api_key|bearer` → `[redacted]`.
- String values matching a Bearer header, a JWT-ish `eyJ…`, or a `?token=/signature=/cron_secret=` query param → `[redacted]`.
- Strings capped at 500 chars; arrays capped at 20 items; recursion depth-limited.

## IP address handling (important distinction)
- **Rate limiting** uses a salted **one-way fingerprint** of IP+UA (`requestFingerprint`). The **raw IP is never persisted** for rate limiting; only the digest lives in the ephemeral, short-TTL in-process limiter map.
- **The TCPA consent ledger** (`portal_consent`, written by `lead-submit`) **deliberately stores raw IP + UA + exact disclosure text** — this is a legal audit requirement (spec §M), not rate-limit data, and is retained per compliance policy. This is the one intentional raw-IP store and is out of scope for the "no raw IP" rate-limit rule.
- `portal_access_log` stores an IP for security audit (existing behavior, preserved).

## Existing call sites
- Functions currently log `e?.message` on failures and short, non-PII markers — acceptable. `_lib/mailer.mjs` and `_lib/portal.logAccess` are fail-soft and do not log bodies. `cronGuard.rejectionLog` logs header **keys only**, never values (never the secret). New/changed code uses generic public errors (`lead-submit` upstream failures now return a generic message and log detail server-side).

## Adoption
`safelog.logEvent`/`publicError` are available for incremental adoption; this phase wires generic public errors on the changed public path and documents the policy. Broad migration of every legacy `console.*` is a follow-up (low risk — current logs are already message-only).
