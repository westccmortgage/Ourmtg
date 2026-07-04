# Private Note Capital

PrivateNoteCapital.com — a private, access-controlled platform for investing in
mortgage notes secured by real estate.

## Design intent

**Trust first. Growth second.** The site reads as a closed investment platform,
not a lending website. The hero is a calm institutional deal-room preview (a note
file with collateral, LTV, lien position, and the document package) — not a
capital-growth animation. Motion is interface-light only: section fades, a slow
status pulse, documents checking in one by one. `prefers-reduced-motion` disables
all of it.

Page order mirrors the formula:

1. Hero — deal-room preview + "Request access"
2. Trust pillars — secured by real estate · reviewed opportunities · LTV / lien / documents · professional review layer
3. "This is not a marketplace" strip
4. How capital works — scenario reviewed → collateral analyzed → note package prepared → investor reviews → servicing tracks payments
5. Deal room — what investors see inside
6. Request access form (Netlify Forms)
7. Disclosures

## Stack

Static HTML + CSS, no build step, no dependencies. `netlify.toml` publishes the
repo root; the access-request form is handled by Netlify Forms automatically.

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
