# OurMTG private document scanner

This service is the malware boundary in front of AI extraction. It receives the bytes of one
document, scans them with ClamAV, deletes the temporary copy, and returns only `clean`, `infected`,
or `error`. It has no Supabase credentials and cannot browse another borrower or file.

Deploy the container as a private operational service (Cloud Run is the current target) with:

- `SCANNER_TOKEN`: a new random secret used only between Netlify and this service.
- 2 GiB memory, 1 CPU, concurrency 1, request timeout at least 60 seconds.
- authenticated HTTPS ingress. The bearer token remains mandatory even when ingress is restricted.

Then set these Netlify variables for Functions/runtime and redeploy:

```text
OURMTG_DOCUMENT_SCAN_PROVIDER=http
OURMTG_DOCUMENT_SCAN_URL=https://<scanner-host>/scan
OURMTG_DOCUMENT_SCAN_TOKEN=<same random secret>
DOCUMENT_UPLOAD_REQUIRE_CLEAN_SCAN=true
```

Do not set `PRE_UNDERWRITING_REQUIRE_CLEAN_SCAN=false` in production. A healthy scanner makes the
existing fail-closed pre-underwriting gate pass without weakening it.

