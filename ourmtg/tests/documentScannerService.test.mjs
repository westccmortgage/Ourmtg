import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const serviceRoot = new URL('../../services/document-scanner/', import.meta.url)

test('scanner image installs the clamdscan client used by the service', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', serviceRoot), 'utf8')
  assert.match(dockerfile, /apt-get install[^\n]*\bclamdscan\b/)
})

test('scanner startup fails closed unless both daemon socket and client are ready', async () => {
  const startup = await readFile(new URL('start.sh', serviceRoot), 'utf8')
  assert.match(startup, /\[ ! -S \/run\/clamav\/clamd\.ctl \]/)
  assert.match(startup, /command -v clamdscan/)
  assert.match(startup, /exit 1/)
})
