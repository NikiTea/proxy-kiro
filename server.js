'use strict'

/**
 * proxy-kiro — zero-runtime-dependency app-level relay for Kiro (AWS CodeWhisperer).
 *
 * Route: /kiro/<path>  ->  UPSTREAM/<path>
 *        default UPSTREAM = https://codewhisperer.us-east-1.amazonaws.com
 *
 * Gate: request header x-relay-key must equal server env RELAY_KEY
 * (timing-safe compare). The header is NEVER forwarded upstream and
 * NEVER written to logs.
 *
 * Responses are piped back without buffering (SSE text/event-stream safe),
 * using only Node built-ins (http + global fetch/undici + ReadableStream).
 *
 * Env:
 *   PORT      listen port (default 3000)
 *   HOST      bind address (default 0.0.0.0)
 *   RELAY_KEY hex secret; when unset, /health works and /kiro/* is disabled
 *   UPSTREAM  upstream base URL (default https://codewhisperer.us-east-1.amazonaws.com)
 */

const crypto = require('node:crypto')
const http = require('node:http')
const { PassThrough, Readable } = require('node:stream')

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'
const RELAY_KEY = process.env.RELAY_KEY || ''
const UPSTREAM = (process.env.UPSTREAM || 'https://codewhisperer.us-east-1.amazonaws.com').replace(/\/+$/, '')
const MAX_BODY = 10 * 1024 * 1024 // 10 MiB request body cap (parity with the CF worker)

// Request headers that must not reach the upstream. Everything else we care
// about is whitelisted explicitly below (content-type, accept, user-agent,
// content-encoding, content-language, x-amz-*).
const STRIP_REQ = new Set([
  'connection', 'keep-alive', 'proxy-authorization', 'te', 'upgrade',
  'host', 'content-length', 'x-relay-key',
])

// Response headers to flush to the client immediately with the status line.
const COPY_RESP_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag', 'retry-after']

function log(...fields) {
  // Never includes x-relay-key or any secret material.
  console.log(new Date().toISOString(), ...fields)
}

function respond(res, status, obj) {
  if (res.destroyed || res.headersSent) return false
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
  return true
}

// Length-checked, timing-safe string compare for the relay key.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

async function relay(req, res, url) {
  const method = req.method

  // 1) Server-side gate: without a configured key the relay stays off.
  if (!RELAY_KEY) {
    log('403', method, url.pathname, 'relay disabled (RELAY_KEY unset)')
    return respond(res, 403, {
      error: 'relay_disabled',
      detail: 'server env RELAY_KEY is not set; set it to enable /kiro/* relay routes',
    })
  }

  // 2) Client gate: x-relay-key must match exactly.
  const supplied = req.headers['x-relay-key']
  if (typeof supplied !== 'string' || !safeEqual(supplied, RELAY_KEY)) {
    log('401', method, url.pathname, 'missing/bad x-relay-key')
    return respond(res, 401, { error: 'unauthorized', detail: 'missing or invalid x-relay-key header' })
  }

  // 3) Build the upstream URL: strip the /kiro prefix, keep query string.
  const path = url.pathname.replace(/^\/kiro/, '') || '/'
  const target = UPSTREAM + path + url.search

  // 4) Forward a whitelist of request headers; skip hop-by-hop, host,
  //    content-length (recomputed upstream via chunked), and x-relay-key.
  const fwd = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    if (STRIP_REQ.has(lk)) continue
    if (lk === 'content-type' || lk === 'accept' || lk === 'user-agent' ||
        lk === 'content-encoding' || lk === 'content-language' ||
        lk.startsWith('x-amz-')) {
      fwd.set(k, v)
    }
  }

  // 5) Stream the request body without buffering, enforcing the size cap.
  const controller = new AbortController()
  let hasBody = !['GET', 'HEAD'].includes(method)
  let bodyStream = null
  if (hasBody) {
    const pt = new PassThrough()
    let bytes = 0
    pt.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        controller.abort('body_too_large')
        respond(res, 413, { error: 'body_too_large', detail: `request body exceeds ${MAX_BODY} bytes` })
      }
    })
    req.pipe(pt)
    req.on('error', () => { if (!res.destroyed && !res.headersSent) respond(res, 499, { error: 'client_error' }) })
    bodyStream = Readable.toWeb(pt)
  }

  let up
  try {
    up = await fetch(target, {
      method,
      headers: fwd,
      body: bodyStream,
      // Required by Node's global fetch (undici) when the body is a
      // (web) ReadableStream: half-duplex streaming.
      ...(bodyStream ? { duplex: 'half' } : {}),
      signal: controller.signal,
    })
  } catch (e) {
    const detail = e.name === 'AbortError' ? String(e.message || 'aborted') : String(e.cause?.message || e.message || e)
    log('502', method, url.pathname, 'upstream error:', detail)
    // Honest 502: network problems reaching AWS surface here, never masked.
    return respond(res, 502, { error: 'upstream_failed', detail })
  }

  // 6) Flush status + selected headers immediately, then stream the body.
  const outHeaders = {}
  for (const h of COPY_RESP_HEADERS) {
    const v = up.headers.get(h)
    if (v !== null) outHeaders[h] = v
  }
  res.writeHead(up.status, outHeaders)
  log(String(up.status), method, url.pathname, `-> ${UPSTREAM + path}`)

  if (up.body) {
    const nodeBody = Readable.fromWeb(up.body)
    nodeBody.pipe(res)

    // If the client goes away mid-stream, abort the upstream fetch and drop
    // the stream so sockets don't linger.
    res.on('close', () => {
      if (!res.finished) controller.abort()
    })
    controller.signal.addEventListener('abort', () => nodeBody.destroy(), { once: true })
    nodeBody.on('error', () => {
      if (!res.destroyed) res.destroy(new Error('upstream stream error'))
    })
    res.on('error', () => nodeBody.destroy())
  } else {
    res.end()
  }
}

const USAGE = {
  service: 'proxy-kiro',
  usage: 'App-level relay for Kiro (AWS CodeWhisperer). Use /kiro/<path> with header x-relay-key set to the server RELAY_KEY. /health is the unauthenticated liveness probe.',
  routes: {
    '/health': 'GET, no auth -> {"ok":true}',
    '/kiro/<path>': 'relayed to upstream (x-relay-key required)',
  },
}

const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return respond(res, 400, { error: 'bad_request' })
  }
  const p = url.pathname

  if (p === '/health') {
    return respond(res, 200, { ok: true })
  }
  if (p === '/') {
    return respond(res, 200, USAGE)
  }
  if (p === '/kiro' || p.startsWith('/kiro/')) {
    relay(req, res, url).catch((e) => {
      log('500', req.method, p, e.message)
      respond(res, 502, { error: 'upstream_failed', detail: String(e.message) })
    })
    return
  }
  log('404', req.method, p)
  respond(res, 404, { error: 'not_found', hint: 'use /kiro/<path> (x-relay-key required) or /health' })
})

server.listen(PORT, HOST, () => {
  console.log(`[proxy-kiro] listening on http://${HOST}:${PORT}`)
  console.log(`[proxy-kiro] upstream: ${UPSTREAM}`)
  if (RELAY_KEY) {
    console.log('[proxy-kiro] relay enabled: /kiro/* gated by x-relay-key')
  } else {
    console.log('[proxy-kiro] RELAY_KEY not set — /kiro/* relay routes are DISABLED (403). Set RELAY_KEY (e.g. `openssl rand -hex 32`) to enable.')
  }
})

// Clean shutdown for systemd (SIGTERM).
process.on('SIGTERM', () => {
  log('SIGTERM', 'shutting down')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
})
