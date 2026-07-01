# OurMTG — Platform Roadmap

Goal: not "another mortgage website" but the **operating layer of the whole transaction**
— every participant (borrower, co-borrower, realtor, LO, processor, escrow/title) works
the same loan file, each seeing exactly what their role allows.

## Shipped (this iteration)

| Capability | Who it serves | How |
|---|---|---|
| Team access (processor / assistant) | LO's staff | `portal_team` (migration 038): members get internal access to every file of their owner — review queue, file detail, doc review, invites |
| Third-party milestone roles | escrow, title | `escrow`/`title` added to portal roles; same structural block as realtors (RLS already excludes them from docs/conditions), milestone-only status |
| Ad-hoc document requests | LO/processor | `portal-doc-request`: request any custom document; appears on the borrower checklist, uploads through the same signed-URL flow |
| Condition management | LO/processor | `portal-condition-set`: create / update / clear underwriting conditions the borrower sees in the portal |
| Two-way messaging | everyone on the file | `portal-message-send` + timeline UI; email notify to the other side, fail-soft |
| Consent ledger actually written | compliance | `lead-submit` appends TCPA/email consent (exact text + IP + UA) to `portal_consent` |
| PWA installability | borrowers | manifest + icon (add-to-home-screen) |

## Next (rough order)

1. **Wire the 24h/72h missing-doc reminders** into GRCRM's `cron-automations`
   (spec §J rules 5–8) — the engine exists; OurMTG only needs the trigger data it
   already writes (`loan_documents.status/requested_at`).
2. **SMS via Twilio** — reuse GRCRM's per-broker credentials; template library is
   already written (spec §L). Decision needed: platform-level vs per-broker sender.
3. **WCCI strategy** — server-to-server call, store draft in `loan_strategy`, LO
   approve/edit UI, borrower sees `status='approved'` only (RLS already enforces).
4. **Closing calendar** for LO/processor (est_close_date across active files).
5. **Document previews** in LO review (image/pdf inline instead of raw link).
6. **Admin surface** — branding, senders, audit-log viewer (`portal_access_log` reader).
7. **Analytics funnel** — lead → app → docs complete → submitted → funded; doc
   turnaround time (the metric the whole product exists to shrink).
8. **E-sign + credit-pull authorization** capture (consent types already modeled).
9. **Hardening**: rate limiting on `lead-submit` and invite accept, Sentry (or similar)
   on functions, CI running `npm run check` + `vite build`, integration tests against a
   Supabase branch database.

## Explicitly out (unchanged from spec §O)

New CRM, second database, marketing site, passwords, public doc storage, client-side
WCCI calls, AI that quotes rates or promises approval, retroactive automation blasts.
