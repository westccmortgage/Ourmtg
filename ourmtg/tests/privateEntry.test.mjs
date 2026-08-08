import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('legacy public lead/application routes cannot create an OurMTG file', async () => {
  const app = await read('src/App.jsx')
  for (const path of ['apply', 'realtor', 'calculator', 'plan', 'who']) {
    assert.match(app, new RegExp(`path="${path}"[^\n]+Navigate to="/login"`), path)
  }
  assert.doesNotMatch(app, /<BuildFile\b|<LeadFlow\b|<Apply\b/)
})

test('the public home describes an invite-only workspace and offers no self-start action', async () => {
  const home = await read('src/pages/Home.jsx')
  assert.match(home, /does not accept public applications/i)
  assert.match(home, /secure link from your mortgage team/i)
  assert.doesNotMatch(home, /Start a file|to="\/plan"/i)
})
