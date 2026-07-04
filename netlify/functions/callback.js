// GitHub OAuth — step 2: GitHub redirects back here with a code. We verify the state,
// exchange the code for an access token, and hand it to Decap CMS via postMessage
// (the standard netlify-cms/decap OAuth handshake).
exports.handler = async (event) => {
  const clientId = process.env.OAUTH_CLIENT_ID
  const clientSecret = process.env.OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return { statusCode: 500, body: 'OAuth env not set' }

  const q = event.queryStringParameters || {}
  const code = q.code
  const state = q.state
  const cookie = event.headers.cookie || event.headers.Cookie || ''
  const saved = (cookie.match(/oauth_state=([^;]+)/) || [])[1]

  if (!code || !state || state !== saved) {
    return { statusCode: 400, body: 'Invalid OAuth state — please try logging in again.' }
  }

  let result, status
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    const data = await r.json()
    if (data.access_token) { result = { token: data.access_token, provider: 'github' }; status = 'success' }
    else { result = { error: data.error_description || data.error || 'No token returned' }; status = 'error' }
  } catch (e) {
    result = { error: e.message || 'Token exchange failed' }; status = 'error'
  }

  const body = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  (function () {
    function receive(e) {
      window.opener.postMessage('authorization:github:${status}:' + JSON.stringify(${JSON.stringify(result)}), e.origin);
      window.removeEventListener('message', receive, false);
    }
    window.addEventListener('message', receive, false);
    if (window.opener) window.opener.postMessage('authorizing:github', '*');
  })();
</script>
Signing you in…
</body></html>`

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'oauth_state=; Path=/; Max-Age=0' },
    body,
  }
}
