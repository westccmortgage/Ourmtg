// In-memory PostgREST/GoTrue stand-in for endpoint tests.
//
// Intercepts at the HTTP layer (global fetch) rather than mocking the Supabase module, so the
// real @supabase/supabase-js client runs: real URL building, real filter encoding, real
// error-shape handling. What is faked is the database behind it.
//
// Scope: exactly the surface the application-* endpoints use — eq filters, order, limit,
// select, insert, upsert(on_conflict), patch, and the unique-violation code (23505) that the
// idempotency and single-application guarantees depend on.
//
// This is NOT a Postgres. It does not enforce RLS, foreign keys, or check constraints — those
// live in migration 003 and can only be verified against a real database.

const UNIQUE_KEYS = {
  mortgage_applications: ['loan_file_id', 'application_version'],
  application_parties: ['application_id', 'party_index'],
  application_turns: ['application_id', 'idempotency_key'],
  application_field_state: ['application_id', 'field_path'],
  application_secure_fields: ['application_id', 'field_path', 'party_id'],
}

// Partial unique indexes the fake cannot express as a plain key list. The live-rule index on
// pre_underwriting_findings applies only WHERE superseded_by is null, and losing that nuance
// would make a legitimate re-run look like a duplicate-key error.
const PARTIAL_UNIQUE = {
  pre_underwriting_findings: {
    keys: ['loan_file_id', 'dedupe_key'],
    where: (r) => r.superseded_by === null || r.superseded_by === undefined,
  },
}

let counter = 0
const uuid = () => {
  counter++
  const h = counter.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${h}`
}

export function createFakeSupabase({ tables = {}, users = {}, storage = {} } = {}) {
  const db = {}
  // path -> { body: Buffer|string, type: string }. Documents live in Storage, not in a table,
  // so the intake endpoint cannot be exercised at all without this.
  const files = { ...storage }
  for (const [t, rows] of Object.entries(tables)) db[t] = rows.map((r) => ({ ...r }))

  const calls = []
  const state = { failNextInsertOn: null }

  function rowsOf(table) {
    if (!db[table]) db[table] = []
    return db[table]
  }

  function applyFilters(rows, params) {
    let out = rows
    for (const [key, raw] of params.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue
      // `is.null` matters more than it looks: the pre-underwriting repo selects live rows with
      // .is('superseded_by', null), and an unimplemented operator here is silently ignored — the
      // query returns superseded rows too and the test passes for the wrong reason.
      const m = /^(eq|in|neq|is)\.(.*)$/s.exec(raw)
      if (!m) continue
      const [, op, value] = m
      if (op === 'is') {
        const wantNull = value === 'null'
        out = out.filter((r) => (r[key] === null || r[key] === undefined) === wantNull)
      } else if (op === 'eq') out = out.filter((r) => String(r[key] ?? '') === value)
      else if (op === 'neq') out = out.filter((r) => String(r[key] ?? '') !== value)
      else if (op === 'in') {
        const list = value.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''))
        out = out.filter((r) => list.includes(String(r[key] ?? '')))
      }
    }
    const order = params.get('order')
    if (order) {
      const [col, dir] = order.split('.')
      out = [...out].sort((a, b) => {
        const av = a[col], bv = b[col]
        const c = av === bv ? 0 : (av > bv ? 1 : -1)
        return dir === 'desc' ? -c : c
      })
    }
    const limit = params.get('limit')
    if (limit) out = out.slice(0, Number(limit))
    return out
  }

  const json = (body, status = 200) => new Response(
    body === null ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  )

  function violatesUnique(table, row) {
    const partial = PARTIAL_UNIQUE[table]
    if (partial) {
      if (!partial.where(row)) return false
      return rowsOf(table).some((r) => partial.where(r)
        && partial.keys.every((k) => String(r[k] ?? '') === String(row[k] ?? '')))
    }
    const keys = UNIQUE_KEYS[table]
    if (!keys) return false
    return rowsOf(table).some((r) => keys.every((k) => String(r[k] ?? '') === String(row[k] ?? '')))
  }

  async function handler(url, opts = {}) {
    const u = new URL(String(url))
    const method = (opts.method || 'GET').toUpperCase()
    calls.push({ method, path: u.pathname, search: u.search })

    // ── GoTrue: verify the caller's JWT ─────────────────────────────────────
    if (u.pathname === '/auth/v1/user') {
      const auth = headerOf(opts.headers, 'authorization') || ''
      const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]
      const user = token ? users[token] : null
      if (!user) return json({ message: 'invalid token' }, 401)
      return json(user)
    }

    // ── Storage: object download ────────────────────────────────────────────
    if (u.pathname.startsWith('/storage/v1/object/')) {
      const path = decodeURIComponent(u.pathname.replace(/^\/storage\/v1\/object\/(authenticated\/)?/, ''))
      const key = path.replace(/^ourmtg-docs\//, '')
      const hit = files[key] ?? files[path]
      if (!hit) return new Response(JSON.stringify({ message: 'Object not found' }), { status: 404 })
      const body = typeof hit.body === 'string' ? Buffer.from(hit.body, 'utf8') : hit.body
      return new Response(body, { status: 200, headers: { 'content-type': hit.type || 'application/octet-stream' } })
    }

    const table = u.pathname.replace('/rest/v1/', '')
    const params = u.searchParams
    const wantsReturn = params.has('select')

    if (method === 'GET') return json(applyFilters(rowsOf(table), params))

    if (method === 'POST') {
      const body = JSON.parse(opts.body || '[]')
      const incoming = Array.isArray(body) ? body : [body]
      const isUpsert = params.has('on_conflict')
      const out = []

      for (const raw of incoming) {
        const row = { id: raw.id || uuid(), created_at: raw.created_at || NOW, ...raw }

        if (state.failNextInsertOn === table) {
          state.failNextInsertOn = null
          return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)
        }

        if (isUpsert) {
          const keys = params.get('on_conflict').split(',')
          const idx = rowsOf(table).findIndex((r) => keys.every((k) => String(r[k] ?? '') === String(row[k] ?? '')))
          if (idx >= 0) { rowsOf(table)[idx] = { ...rowsOf(table)[idx], ...raw }; out.push(rowsOf(table)[idx]); continue }
        } else if (violatesUnique(table, row)) {
          // The real 23505 the repo layer's race handling depends on.
          return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)
        }
        rowsOf(table).push(row)
        out.push(row)
      }
      return wantsReturn ? json(out) : json(null, 204)
    }

    if (method === 'PATCH') {
      const patch = JSON.parse(opts.body || '{}')
      const matched = applyFilters(rowsOf(table), params)
      for (const r of matched) Object.assign(r, patch)
      return wantsReturn ? json(matched) : json(null, 204)
    }

    if (method === 'DELETE') {
      const matched = new Set(applyFilters(rowsOf(table), params))
      db[table] = rowsOf(table).filter((r) => !matched.has(r))
      return json(null, 204)
    }
    return json({ message: 'unsupported' }, 400)
  }

  return {
    fetch: handler,
    db,
    calls,
    rowsOf,
    files,
    putFile: (path, body, type) => { files[path] = { body, type } },
    failNextInsertOn: (t) => { state.failNextInsertOn = t },
  }
}

const NOW = '2026-07-29T12:00:00.000Z'

function headerOf(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return hit ? headers[hit] : null
}

/** Build a Request the Netlify handlers accept. */
export function makeRequest(url, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Env the handlers need before their modules are imported. */
export function setTestEnv(extra = {}) {
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE = 'service-role-key'
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.VITE_SUPABASE_URL = 'https://fake.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key'
  process.env.OURMTG_SECURE_FIELD_KEY = 'test-secure-key'
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
