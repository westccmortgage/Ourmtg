// GitHub OAuth — step 1: send the CMS user to GitHub to authorize.
// Decap CMS (github backend) opens this endpoint; we redirect to GitHub's consent
// screen and stash a random state in a short-lived cookie to guard the callback.
const crypto = require('crypto')

exports.handler = async (event) => {
  const clientId = process.env.OAUTH_CLIENT_ID
  if (!clientId) return { statusCode: 500, body: 'OAUTH_CLIENT_ID not set' }

  const host = event.headers['x-forwarded-host'] || event.headers.host
  const redirectUri = `https://${host}/.netlify/functions/callback`
  const state = crypto.randomBytes(12).toString('hex')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo',
    state,
    allow_signup: 'false',
  })

  return {
    statusCode: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params.toString()}`,
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`,
    },
    body: '',
  }
}
