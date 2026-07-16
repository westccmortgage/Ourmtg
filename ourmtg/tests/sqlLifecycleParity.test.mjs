import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { TASK_TRANSITIONS, ACTION_TO_STATUS } from '../netlify/functions/_lib/taskLifecycle.mjs'

test('migration transition graph exactly matches the server/domain lifecycle', async () => {
  const sql = await readFile(new URL('../docs/phase1c/migration/043_ourmtg_operational_pilot.sql', import.meta.url), 'utf8')
  const body = sql.slice(sql.indexOf('create or replace function public.ourmtg_task_next_status'), sql.indexOf('create or replace function public.ourmtg_task_event_type'))
  const parsed = new Map()
  const re = /when p_action='([^']+)' and p_from(?:='([^']+)'| in \(([^)]+)\)) then '([^']+)'/g
  for (const match of body.matchAll(re)) {
    const [, action, one, many, to] = match
    const froms = one ? [one] : [...many.matchAll(/'([^']+)'/g)].map((m) => m[1])
    parsed.set(action, { froms: froms.sort(), to })
  }

  assert.deepEqual([...parsed.keys()].sort(), Object.keys(ACTION_TO_STATUS).sort())
  for (const [action, to] of Object.entries(ACTION_TO_STATUS)) {
    const expectedFroms = Object.entries(TASK_TRANSITIONS)
      .filter(([, destinations]) => destinations.includes(to))
      .map(([from]) => from)
      .sort()
    assert.equal(parsed.get(action).to, to, `${action}: target status`)
    assert.deepEqual(parsed.get(action).froms, expectedFroms, `${action}: allowed source states`)
  }
})
