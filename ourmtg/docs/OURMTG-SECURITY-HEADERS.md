# OURMTG — Security Headers (Phase 1A §10)

Configured in the repo-root `netlify.toml` `[[headers]]` blocks. Applied by Netlify at serve time (not build time).

## Headers on `/*` (the SPA)
| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see below | limit script/connect/style/img origins; block framing & object embeds |
| `X-Content-Type-Options` | `nosniff` | stop MIME sniffing |
| `X-Frame-Options` | `DENY` | legacy clickjacking defense (pairs with CSP `frame-ancestors 'none'`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | don't leak full URLs cross-origin |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), interest-cohort=()` | disable unused powerful features |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | force HTTPS |

## CSP
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self' https://*.supabase.co wss://*.supabase.co;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none'
```

### Required external origins (update the CSP if these change)
| Origin | Directive | Reason |
|---|---|---|
| `'self'` | script/connect/img/style/font | hashed Vite bundle, SPA assets, same-origin `/.netlify/functions/*` |
| `https://*.supabase.co` | connect-src | Supabase Auth (magic link), Storage, signed-URL upload/download |
| `wss://*.supabase.co` | connect-src | Supabase client websocket (auth/realtime channel if opened) |
| `data:` | img-src, font-src | QR code data URLs (`QRCode.jsx`), the app icon/manifest |

### Why `'unsafe-inline'` for styles (only)
The React app uses inline `style={{…}}` attributes throughout. CSP `style-src` blocks inline style attributes without `'unsafe-inline'`, so it is required for styles. **Scripts do not use inline** — `script-src 'self'` stays strict (the Vite bundle is external + content-hashed). Removing the inline-style dependency (e.g. moving to classes) is a future hardening to enable a stricter `style-src`.

## API / function responses
- `/.netlify/functions/*` → `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`. Functions also set `no-store` themselves (`_lib/portal.json`, `lead-submit`) — defense in depth.

## Static assets
- `/assets/*` → `Cache-Control: public, max-age=31536000, immutable` (safe: Vite filenames are content-hashed).

## Verification
- `npm run build` succeeds with these committed (build is unaffected; headers apply at serve time).
- Post-deploy, verify with `curl -I https://ourmtg.com/` and confirm the app still loads (no CSP console violations). If a new external origin is added (e.g. analytics), extend the CSP or the app will break — do not broaden to `*`.
