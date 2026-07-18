# `src/domain/` — pure domain scaffolding (Phase 0)

**Status: reference scaffolding. Nothing here is wired into production. All feature flags default OFF.**

## Why this directory exists

Phase 0 reconciles useful ideas from a previous (backend-only, GRCRM-scoped) scratchpad
against the *actual* OurMTG application. This directory holds the **pure, dependency-free
domain contracts** that survived that reconciliation:

- `flags.js` — feature flags for Phase 1+ capabilities. **Every flag defaults to `false`.**
  Nothing reads these yet; they exist so future work can gate additively.
- `vocab.js` — the single, canonical re-export of vocabularies the app **already** defines
  (loan stages, document/condition/strategy statuses), plus **new** dotted event-type and
  task/vendor/delivery constants that do not exist anywhere else yet. This file deliberately
  **re-exports** existing enums instead of redefining them, so there is never a second,
  drifting copy of "the stages."
- `contracts.js` — JSDoc `@typedef` contracts for the **new** domain objects proposed in
  `docs/OURMTG-TARGET-DATA-MODEL.md` (events, tasks, deliveries, vendor orders, cash-to-close).
  These are documentation-as-code: zero runtime, no side effects, importable for editor
  intellisense and future implementation.

## Why here (and not `ourmtg/domain/` or the functions tree)

The app is a Vite/React SPA with **all application code under `ourmtg/src/`**. Putting the
domain contracts under `ourmtg/src/domain/` keeps them:

1. **Co-located** with the code that will first consume them (the SPA + its `src/lib`
   vocabularies this file re-exports — e.g. `src/lib/pipeline.js`).
2. **Inside the Vite build graph**, so imports resolve with the same module resolution as the
   rest of the app and the contract test runs with `node --test` from `ourmtg/`.
3. **Consistent** with the existing convention (`src/lib/` for shared logic). A top-level
   `ourmtg/domain/` would sit outside `src/` and outside the build root for no benefit.

**Note on the functions tree:** the Netlify functions (`netlify/functions/`) are self-contained
ESM (`_lib` is intentionally duplicated from GRCRM, per `OURMTG_HANDOFF.md`). If/when a function
needs these contracts at runtime, follow that same self-contained pattern rather than importing
across the `src`/`functions` boundary. Until then, these are frontend-and-planning artifacts.

## Rules (Phase 0)

- Do **not** wire any of this into production code.
- Do **not** redefine an enum the app already has — re-export from `vocab.js`.
- Keep every flag `false` by default.
- No new runtime dependencies. The contract test uses Node's built-in `node:test` + `node:assert`.
