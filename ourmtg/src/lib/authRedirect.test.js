import test from 'node:test'
import assert from 'node:assert/strict'
import { absoluteAuthRedirect, safeAuthReturnPath } from './authRedirect.js'

test('auth return path preserves an invite and its known destination', () => {
  const path = '/invite?token=0123456789abcdef0123456789abcdef&go=application'
  assert.equal(safeAuthReturnPath(path), path)
  assert.equal(absoluteAuthRedirect(path, 'https://ourmtg.com/'), `https://ourmtg.com${path}`)
})

test('auth return path rejects cross-origin and browser-ambiguous values', () => {
  for (const value of [
    'https://attacker.example',
    '//attacker.example/path',
    '/\\attacker.example/path',
    '\\attacker.example/path',
    '',
    null,
  ]) {
    assert.equal(safeAuthReturnPath(value), '/portal')
  }
})

test('auth return path preserves a local path, query and fragment', () => {
  assert.equal(
    safeAuthReturnPath('/portal/file/loan-1?tab=documents#income'),
    '/portal/file/loan-1?tab=documents#income',
  )
})
