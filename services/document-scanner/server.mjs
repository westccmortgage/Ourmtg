import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PORT || 8080)
const TOKEN = String(process.env.SCANNER_TOKEN || '')
const MAX_BYTES = 25 * 1024 * 1024

function authorized(header) {
  const supplied = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''))
  const expected = Buffer.from(TOKEN)
  return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function reply(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function bodyOf(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BYTES) throw Object.assign(new Error('too_large'), { code: 'too_large' })
    chunks.push(chunk)
  }
  if (!size) throw Object.assign(new Error('empty'), { code: 'empty' })
  return Buffer.concat(chunks)
}

function clamScan(path) {
  return new Promise((resolve) => {
    const child = spawn('clamdscan', ['--fdpass', '--no-summary', path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk).slice(0, 500) })
    child.stderr.on('data', (chunk) => { output += String(chunk).slice(0, 500) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('error', () => { clearTimeout(timer); resolve({ status: 'error', detail: 'scanner_unavailable' }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ status: 'clean' })
      else if (code === 1) resolve({ status: 'infected', detail: 'malware_detected' })
      else resolve({ status: 'error', detail: /connection/i.test(output) ? 'scanner_not_ready' : 'scan_failed' })
    })
  })
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true })
  if (req.method !== 'POST' || req.url !== '/scan') return reply(res, 404, { error: 'not_found' })
  if (!authorized(req.headers.authorization)) return reply(res, 401, { error: 'unauthorized' })
  if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/octet-stream') {
    return reply(res, 415, { error: 'unsupported_content_type' })
  }

  let dir = null
  try {
    const bytes = await bodyOf(req)
    dir = await mkdtemp(join(tmpdir(), 'ourmtg-scan-'))
    const path = join(dir, 'document')
    await writeFile(path, bytes, { mode: 0o600 })
    return reply(res, 200, await clamScan(path))
  } catch (error) {
    if (error?.code === 'too_large') return reply(res, 413, { status: 'error', detail: 'file_too_large' })
    if (error?.code === 'empty') return reply(res, 422, { status: 'error', detail: 'empty_file' })
    return reply(res, 500, { status: 'error', detail: 'scan_failed' })
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

server.listen(PORT, '0.0.0.0')

