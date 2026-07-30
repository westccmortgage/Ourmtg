// supabase/apply/prod_003_conversational_1003.sql is a one-paste convenience wrapper: the same
// SQL as the delta, plus a plain-language verdict instead of a JSON blob. A wrapper that drifts
// from the delta it claims to mirror is worse than no wrapper at all — someone would apply the
// stale copy to the live project believing they had applied the reviewed one. These tests are
// what make the "GENERATED FILE" claim in its header true.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const delta = readFileSync(join(root, 'supabase/delta/003_conversational_1003.sql'), 'utf8')
const apply = readFileSync(join(root, 'supabase/apply/prod_003_conversational_1003.sql'), 'utf8')

// The transactional body — everything the database actually executes.
const body = (sql) => {
  const start = sql.indexOf('\nbegin;')
  const end = sql.indexOf('\ncommit;')
  assert.ok(start !== -1 && end > start, 'expected a begin;/commit; block')
  return sql.slice(start, end + '\ncommit;'.length)
}

test('apply script executes the delta verbatim', () => {
  assert.equal(body(apply), body(delta))
})

test('apply script keeps the wrong-project guard', () => {
  assert.match(apply, /Wrong or incomplete project: OurMTG core is missing/)
  // The guard must sit inside the transaction and before the first table, or an abort could
  // leave half a schema behind.
  assert.ok(apply.indexOf('OurMTG core is missing') < apply.indexOf('create table'))
  assert.ok(apply.indexOf('\nbegin;') < apply.indexOf('OurMTG core is missing'))
})

test('apply script never alters, drops, or writes to pre-existing objects', () => {
  const statements = body(apply)
    .split('\n')
    .filter((l) => /^\s*(alter|drop|truncate|delete|insert|update)\b/i.test(l))
  // The only permitted mutation is enabling RLS on tables this file itself created.
  for (const s of statements) {
    assert.match(s, /^alter table public\.(mortgage_applications|application_\w+) enable row level security;$/,
      `unexpected mutating statement: ${s.trim()}`)
  }
})

test('every table the apply script creates is server-only', () => {
  const created = [...body(apply).matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1])
  assert.equal(created.length, 7)
  for (const t of created) {
    assert.match(apply, new RegExp(`alter table public\\.${t} enable row level security;`))
    assert.match(apply, new RegExp(`revoke all privileges on table public\\.${t} from anon, authenticated;`))
  }
})

test('apply script reports a single plain-language verdict', () => {
  // A JSON blob the reader has to interpret is the thing this wrapper exists to remove.
  assert.match(apply, /PASS - 7 tables created/)
  assert.match(apply, /FAIL - tables_found=/)
  assert.doesNotMatch(apply.slice(apply.indexOf('\ncommit;')), /jsonb_build_object/)
})
