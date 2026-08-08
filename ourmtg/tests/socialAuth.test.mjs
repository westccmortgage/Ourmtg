import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Google is an authentication option, while email remains available and passwords stay absent', async () => {
  const [auth, login] = await Promise.all([
    read('src/lib/auth.jsx'),
    read('src/pages/Login.jsx'),
  ])

  assert.match(auth, /signInWithOAuth\(\{[\s\S]*provider:\s*'google'/)
  assert.match(auth, /signInWithOtp\(/)
  assert.match(login, /signInWithGoogle/)
  assert.match(login, /signInWithEmail/)
  assert.doesNotMatch(`${auth}\n${login}`, /signInWithPassword|password\s*=/i)
})

test('social sign-in preserves only a same-origin return route', async () => {
  const login = await read('src/pages/Login.jsx')
  assert.match(login, /safeAuthReturnPath\(location\.state\?\.from\)/)
  assert.match(login, /absoluteAuthRedirect\(from,\s*window\.location\.origin\)/)
})

test('Google authentication does not weaken invite-only file authorization', async () => {
  const [config, login, invite] = await Promise.all([
    read('src/lib/config.js'),
    read('src/pages/Login.jsx'),
    read('netlify/functions/portal-invite-accept.mjs'),
  ])

  assert.match(config, /VITE_GOOGLE_AUTH_ENABLED/)
  assert.match(login, /GOOGLE_AUTH_ENABLED\s*&&/)
  assert.match(invite, /emailVerified\s*=\s*!!\(user\.email_confirmed_at\s*\|\|\s*user\.confirmed_at\)/)
  assert.match(invite, /!emailVerified\s*\|\|\s*userEmail\s*!==\s*invite\.email\.toLowerCase\(\)/)
  assert.match(invite, /portal_access/)
})
