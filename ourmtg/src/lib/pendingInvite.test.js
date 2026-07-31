// The parked invite is what rescues a borrower who signed in via the account-confirmation
// email instead of the invite link — the exact dead end that stranded a real tester on a
// "what brings you here?" chooser while their invite sat unopened in the same inbox.
import test from 'node:test'
import assert from 'node:assert/strict'

// A stand-in for localStorage. The module reads globalThis lazily, so this has to exist before
// the first call, not before the import.
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)) },
  removeItem: (k) => { mem.delete(k) },
}

const { rememberInvite, pendingInvite, forgetInvite } = await import('./pendingInvite.js')

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const KEY = 'ourmtg.pendingInvite'

test('a parked invite comes back with its destination', () => {
  mem.clear()
  rememberInvite(TOKEN, 'application')
  assert.deepEqual(pendingInvite(), { token: TOKEN, go: 'application' })
})

test('forgetting clears it', () => {
  mem.clear()
  rememberInvite(TOKEN, 'documents')
  forgetInvite()
  assert.equal(pendingInvite(), null)
})

test('nothing parked reads as nothing', () => {
  mem.clear()
  assert.equal(pendingInvite(), null)
})

test('a malformed token is never parked', () => {
  mem.clear()
  for (const bad of ['', null, undefined, 'short', `${TOKEN}extra`, '../../etc']) {
    rememberInvite(bad, 'application')
    assert.equal(pendingInvite(), null, `parked ${JSON.stringify(bad)}`)
  }
})

test('corrupt storage is treated as empty, not thrown', () => {
  // Another tab, an extension, or a half-written value must not take the portal down.
  for (const junk of ['not json', '{}', '{"token":"nope","at":1}', '[]', 'null']) {
    mem.clear(); mem.set(KEY, junk)
    assert.equal(pendingInvite(), null, `survived ${junk}`)
  }
})

test('a day-old invite is treated as absent', () => {
  mem.clear()
  mem.set(KEY, JSON.stringify({ token: TOKEN, go: 'application', at: Date.now() - 86_400_001 }))
  assert.equal(pendingInvite(), null)
  // Just inside the window still counts.
  mem.set(KEY, JSON.stringify({ token: TOKEN, go: 'application', at: Date.now() - 3_600_000 }))
  assert.deepEqual(pendingInvite(), { token: TOKEN, go: 'application' })
})

test('a missing timestamp does not park forever', () => {
  mem.clear()
  mem.set(KEY, JSON.stringify({ token: TOKEN, go: 'application' }))
  assert.equal(pendingInvite(), null)
})

test('storage that throws is survivable', () => {
  // Safari private mode throws on setItem. Losing the rescue is acceptable; crashing is not.
  const good = globalThis.localStorage
  globalThis.localStorage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  assert.doesNotThrow(() => rememberInvite(TOKEN, 'application'))
  assert.equal(pendingInvite(), null)
  assert.doesNotThrow(() => forgetInvite())
  globalThis.localStorage = good
})
