# OurMTG private document scanner

This service is the malware boundary in front of AI extraction. It receives the bytes of one
document, scans them with ClamAV, deletes the temporary copy, and returns only `clean`, `infected`,
or `error`. It has no Supabase credentials and cannot browse another borrower or file.

Deploy the container as a dedicated operational service (Cloud Run is the current target) with:

- `SCANNER_TOKEN`: a new random secret used only between Netlify and this service.
- 2 GiB memory, 1 CPU, concurrency 1, request timeout at least 60 seconds.
- a public HTTPS endpoint so Netlify can reach it; `/scan` still refuses every request without
  the independently generated bearer secret and accepts no URLs or storage credentials.

From Google Cloud Shell, with the repository checked out:

```sh
SCANNER_SECRET="$(openssl rand -hex 32)"
gcloud run deploy ourmtg-document-scanner \
  --source services/document-scanner \
  --region us-west1 \
  --memory 2Gi \
  --cpu 1 \
  --concurrency 1 \
  --timeout 60 \
  --min-instances 1 \
  --allow-unauthenticated \
  --set-env-vars "SCANNER_TOKEN=${SCANNER_SECRET}"
```

Keep the printed `SCANNER_SECRET` only long enough to put it into Netlify; do not paste it into
chat, source control, screenshots, or a ticket. The minimum instance avoids a ClamAV cold start
exceeding Netlify's scan timeout; it has an ongoing Cloud Run cost.

Then set these Netlify variables for Functions/runtime and redeploy:

```text
OURMTG_DOCUMENT_SCAN_PROVIDER=http
OURMTG_DOCUMENT_SCAN_URL=https://<scanner-host>/scan
OURMTG_DOCUMENT_SCAN_TOKEN=<same random secret>
DOCUMENT_UPLOAD_REQUIRE_CLEAN_SCAN=true
```

Do not set `PRE_UNDERWRITING_REQUIRE_CLEAN_SCAN=false` in production. A healthy scanner makes the
existing fail-closed pre-underwriting gate pass without weakening it.
