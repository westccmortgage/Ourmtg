// The whole product, running for real, locally.
//
//   Chromium  →  the built SPA (dist/)  →  the REAL netlify functions  →  the fake Supabase
//                                            ↘ a routed model stub for api.anthropic.com
//
// This exists because the live site is unreachable from this sandbox and the per-endpoint tests
// have already been individually right and collectively wrong. What runs here is the actual
// bundle a borrower would load, calling the actual handlers — the only fakes are the database
// and the model, both from the same world the journey test asserts by hand.
//
// Run: node tests/uiHarness.mjs   (starts the server, drives the browser, writes screenshots +
// a console-error report to the scratch dir, exits non-zero if any page hard-errored)

import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { setTestEnv } from './_fakeSupabase.mjs'
import { LOAN, OWNER, BORROWER, USERS, DOCS, routedModel, buildWorld } from './_journeyWorld.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const OUT = process.env.UI_OUT || '/tmp/claude-0/-home-user-Ourmtg/afdd5109-bb40-5af9-ba17-71bf0e976bb9/scratchpad/ui'
mkdirSync(OUT, { recursive: true })

// ── world + env ─────────────────────────────────────────────────────────────
setTestEnv({
  CONVERSATIONAL_1003_ENABLED: 'true',
  PRE_UNDERWRITING_ENABLED: 'true',
  ANTHROPIC_API_KEY: 'test-key-not-real',
  OURMTG_DOCUMENT_SCAN_PROVIDER: 'mock', OURMTG_ALLOW_MOCK_SCAN: 'true',
  OURMTG_ADMIN_EMAILS: 'lo@wcc.com',
})
const fake = buildWorld()
const model = routedModel()

// Functions and the browser share one fetch world: anything aimed at the fake Supabase or at
// Anthropic is answered in-process; everything else is refused loudly rather than escaping.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const s = String(url)
  if (s.includes('fake.supabase.co')) return fake.fetch(url, opts)
  if (s.includes('api.anthropic.com')) {
    const body = JSON.parse(opts?.body || '{}')
    const first = body?.messages?.[0]?.content
    // Document reads get the routed world; conversational turns get a 500 so the interview
    // exercises its deterministic fallback — the same degraded path a real outage takes.
    if (Array.isArray(first) && ['document', 'image'].includes(first[0]?.type)) return model(url, opts)
    return { ok: false, status: 500, text: async () => 'stubbed outage', json: async () => ({}) }
  }
  if (s.startsWith('http://127.0.0.1') || s.startsWith('http://localhost')) return realFetch(url, opts)
  throw new Error(`unexpected outbound fetch: ${s.slice(0, 120)}`)
}

const TOKEN_USER = { 'tok-owner': OWNER, 'tok-borrower': BORROWER }

// ── the bridge server ───────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }
const handlers = new Map()
async function handlerFor(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null
  if (!handlers.has(name)) {
    const path = join(ROOT, 'netlify/functions', `${name}.mjs`)
    if (!existsSync(path)) return null
    handlers.set(name, (await import(path)).default)
  }
  return handlers.get(name)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:8787')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const bodyBuf = Buffer.concat(chunks)

    // Real functions, exactly as deployed.
    if (url.pathname.startsWith('/.netlify/functions/')) {
      const name = url.pathname.split('/').pop()
      const fn = await handlerFor(name)
      if (!fn) { res.writeHead(404).end('no such function'); return }
      const request = new Request(`https://app.local${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
      })
      const out = await fn(request)
      res.writeHead(out.status, Object.fromEntries(out.headers))
      res.end(Buffer.from(await out.arrayBuffer()))
      return
    }

    // The browser's direct Supabase traffic (auth/rest/storage) → the same fake database the
    // functions use. portal_access gets the one slice of RLS the UI depends on: your own rows.
    if (/^\/(rest|auth|storage)\//.test(url.pathname)) {
      let target = `https://fake.supabase.co${req.url}`
      if (url.pathname === '/rest/v1/portal_access' && req.method === 'GET') {
        const auth = String(req.headers.authorization || '')
        const userId = TOKEN_USER[auth.replace(/^Bearer\s+/i, '')] || 'nobody'
        const u = new URL(target)
        u.searchParams.set('portal_user', `eq.${userId}`)
        target = u.toString()
      }
      const out = await fake.fetch(target, {
        method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf.toString(),
      })
      res.writeHead(out.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(Buffer.from(await out.arrayBuffer()))
      return
    }

    // Static SPA with history fallback.
    let file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!existsSync(file) || !extname(file)) file = join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  } catch (e) {
    res.writeHead(500).end(String(e?.message || e))
  }
})
await new Promise((r) => server.listen(8787, '127.0.0.1', r))

// ── pre-stage the file the way the journey does ─────────────────────────────
// 1003 facts via the real team endpoint, credit authorized, every document read — so the
// browser opens a RICH file, not an empty one.
async function call(name, { method = 'GET', token = 'tok-owner', body, qs = '' } = {}) {
  const fn = await handlerFor(name)
  const out = await fn(new Request(`https://app.local/.netlify/functions/${name}${qs}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }))
  const json = await out.json().catch(() => null)
  if (out.status !== 200) throw new Error(`${name} ${out.status}: ${JSON.stringify(json).slice(0, 200)}`)
  return json
}
const k = (s) => `ui.${s}.${Math.random().toString(36).slice(2, 10)}`

for (const [path, value] of [
  ['parties[0].hasAnyLiabilities', 'yes'],
  ['parties[0].liabilities[0].liabilityType', 'revolving'],
  ['parties[0].liabilities[0].creditorName', 'Chase Card'],
  ['parties[0].liabilities[0].monthlyPayment', '185'],
  ['parties[0].liabilities[0].unpaidBalance', '4210'],
  ['parties[0].liabilities[0].toBePaidOffAtClosing', 'no'],
  ['loan.requestedLoanAmount', '496000'],
]) {
  await call('application-team-review', { method: 'POST', body: { loanFileId: LOAN, action: 'correct', fieldPath: path, value, idempotencyKey: k('f') } })
}
await call('credit-authorization', {
  method: 'POST', token: 'tok-borrower',
  body: { loanFileId: LOAN, accepted: true, documentVersion: (await call('credit-authorization', { token: 'tok-borrower', qs: `?loanFileId=${LOAN}` })).documentVersion, presentedAt: new Date(Date.now() - 9000).toISOString(), idempotencyKey: k('auth') },
})
for (const d of Object.values(DOCS)) {
  await call('pre-underwriting-intake', { method: 'POST', body: { loanFileId: LOAN, documentId: d.id, idempotencyKey: k(d.tag) } })
}
console.log('world staged: 1003 facts, credit auth, all documents read')

// ── drive the browser ───────────────────────────────────────────────────────
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })

const SESSION = (token, id, email) => JSON.stringify({
  access_token: token, token_type: 'bearer', expires_in: 86400,
  expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: 'r',
  user: { id, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
})

const report = []
async function visit(persona, token, id, email, pages) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
  await ctx.addInitScript(([s]) => {
    // supabase-js derives its storage key from the project hostname's first label.
    for (const key of ['sb-127-auth-token', 'sb-localhost-auth-token']) localStorage.setItem(key, s)
  }, [SESSION(token, id, email)])
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 300)}`) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 300)}`))
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errors.push(`[requestfailed] ${r.url().slice(0, 160)} ${r.failure()?.errorText}`) })

  for (const [name, path, ready] of pages) {
    errors.length = 0
    await page.goto(`http://127.0.0.1:8787${path}`, { waitUntil: 'networkidle' }).catch((e) => errors.push(`[goto] ${e}`))
    if (ready) await page.waitForSelector(ready, { timeout: 8000 }).catch(() => errors.push(`[missing] expected "${ready}" on ${path}`))
    await page.waitForTimeout(400)
    const shot = join(OUT, `${persona}-${name}.png`)
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    const text = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 20000)
    report.push({ persona, name, path, errors: [...errors], text })
    console.log(`${persona} ${name}: ${errors.length ? `${errors.length} error(s)` : 'clean'}`)
  }
  await ctx.close()
}

await visit('lo', 'tok-owner', OWNER, 'lo@wcc.com', [
  ['dashboard', '/portal', 'text=Loan team dashboard'],
  ['file', `/portal/file/${LOAN}`, 'text=Documents'],
  ['pre-underwriting', `/portal/file/${LOAN}/pre-underwriting`, 'text=Loan readiness'],
  ['team-1003', `/portal/file/${LOAN}/application`, 'text=Conversational application'],
  ['take-1003', `/portal/file/${LOAN}/application/take`, 'text=Take this application'],
  ['application-entry', '/application', null],
])
await visit('borrower', 'tok-borrower', BORROWER, 'daria@example.com', [
  ['portal', '/portal', null],
  ['assistant', `/application/assistant/${LOAN}`, null],
  ['documents', `/portal/documents/${LOAN}`, null],
])

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const bad = report.filter((r) => r.errors.length)
console.log(`\n${report.length} pages, ${bad.length} with errors → ${OUT}`)
for (const r of bad) { console.log(`\n■ ${r.persona}/${r.name} (${r.path})`); for (const e of r.errors) console.log('  ' + e) }
await browser.close()
server.close()
process.exit(0)
