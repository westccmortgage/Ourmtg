# OurMTG Google sign-in rollout

Google is a convenience authentication method, not an authorization method. A Google account
receives no file access unless the existing server-side invite, `portal_access`, or active
loan-team relationship permits it. The email magic link remains available as a fallback.

## Before enabling the button

1. In Google Cloud, create the OAuth web client for OurMTG.
2. Add the Supabase callback URL shown on **Authentication → Providers → Google** to the Google
   client's authorized redirect URIs. It has the form:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. In Supabase, enable Google and enter that client's ID and secret.
4. In Supabase URL Configuration, keep the production site URL on `https://ourmtg.com` and allow
   production return URLs needed by the app, including invite routes. Do not add an unrelated or
   wildcard external domain.
5. In Netlify, set `VITE_GOOGLE_AUTH_ENABLED=true`, then deploy. The flag only mounts the button;
   it grants no backend capability.

## Acceptance check

- Open a fresh invite in a normal browser and choose **Continue with Google**.
- Use the Google account with the exact verified email to which the invite was issued.
- Confirm the browser returns to that same invite and opens the intended application/documents
  destination.
- Sign out, use a different Google account, and confirm the invite is refused without granting
  any file access.
- Confirm **Email me a secure link** still works.
- Confirm a loan-team account still reaches the authenticator/AAL2 step when internal MFA is
  enabled. Google does not replace that second factor.

Apple sign-in is intentionally not in this rollout. Its private-relay email option needs a
separate identity-linking flow so it cannot be mistaken for the email to which an invite was
issued.
