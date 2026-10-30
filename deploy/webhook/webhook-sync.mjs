#!/usr/bin/env node
// Receiver opzionale del webhook GitHub `push`: accelera la sincronizzazione del
// checkout della wiki. Il timer systemd resta la rete di sicurezza: se il webhook
// non arriva, il checkout converge comunque entro un paio di minuti.
//
// Nessuna dipendenza npm. Ascolta SOLO su 127.0.0.1: va messo dietro un reverse
// proxy con TLS (vedi deploy/README.md).
//
// Variabili d'ambiente:
//   WEBHOOK_SECRET       obbligatoria: segreto condiviso con GitHub (HMAC SHA-256)
//   WEBHOOK_BRANCH       branch che innesca la sincronizzazione (default: main)
//   WEBHOOK_PORT         porta di ascolto (default: 9000)
//   WEBHOOK_PATH         percorso del webhook (default: /webhook)
//   WEBHOOK_SYNC_SCRIPT  script da eseguire (default: ../sync-wiki.sh)
//   WEBHOOK_SYNC_TIMEOUT_MS  timeout dello script in ms (default: 300000)
// Le variabili WIKI_* di sync-wiki.sh vengono ereditate dal processo figlio.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const PORT = Number(process.env.WEBHOOK_PORT ?? 9000)
const PATH = process.env.WEBHOOK_PATH ?? '/webhook'
const BRANCH = process.env.WEBHOOK_BRANCH ?? 'main'
const SECRET = process.env.WEBHOOK_SECRET
const SYNC_SCRIPT =
  process.env.WEBHOOK_SYNC_SCRIPT ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sync-wiki.sh')
const SYNC_TIMEOUT_MS = Number(process.env.WEBHOOK_SYNC_TIMEOUT_MS ?? 300_000)
const MAX_BODY_BYTES = 1024 * 1024

if (!SECRET) {
  console.error('WEBHOOK_SECRET non impostato: obbligatorio. Interrompo.')
  process.exit(1)
}

const log = (msg) => console.log(`${new Date().toISOString()} webhook-sync: ${msg}`)

// --- Coalescenza ---------------------------------------------------------
// Al massimo una sincronizzazione in corso e una in coda: i push ravvicinati
// si fondono, perché ogni sincronizzazione porta il checkout all'ultimo stato.
let running = false
let pending = false

function requestSync(reason) {
  if (running) {
    if (!pending) log(`sincronizzazione in corso, ne accodo una successiva (${reason})`)
    pending = true
    return
  }
  runSync(reason)
}

function runSync(reason) {
  running = true
  log(`avvio sincronizzazione (${reason})`)
  // execFile: nessuna shell, nessun input del webhook arriva alla riga di comando.
  execFile(
    SYNC_SCRIPT,
    [],
    { env: process.env, timeout: SYNC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      for (const line of `${stdout}${stderr}`.split('\n').filter(Boolean)) log(`  | ${line}`)
      if (error) log(`sincronizzazione FALLITA: ${error.message}`)
      else log('sincronizzazione completata')
      running = false
      if (pending) {
        pending = false
        runSync('coda')
      }
    },
  )
}

// --- Verifica firma ------------------------------------------------------
function validSignature(rawBody, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = createHmac('sha256', SECRET).update(rawBody).digest()
  const received = Buffer.from(header.slice('sha256='.length), 'hex')
  // timingSafeEqual lancia se le lunghezze differiscono.
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload troppo grande'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    log(`errore: ${error.message}`)
    if (!res.headersSent) reply(res, 400, { error: 'bad request' })
  })
})

async function handle(req, res) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')

  if (pathname === '/healthz' && req.method === 'GET') {
    reply(res, 200, { status: 'ok' })
    return
  }
  if (pathname !== PATH) {
    reply(res, 404, { error: 'not found' })
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    reply(res, 405, { error: 'method not allowed' })
    return
  }

  const rawBody = await readBody(req)
  if (!validSignature(rawBody, req.headers['x-hub-signature-256'])) {
    log('firma non valida, richiesta rifiutata')
    reply(res, 401, { error: 'invalid signature' })
    return
  }

  const event = req.headers['x-github-event']
  if (event === 'ping') {
    reply(res, 200, { status: 'pong' })
    return
  }
  if (event !== 'push') {
    reply(res, 202, { status: 'ignored', reason: `evento ${String(event)}` })
    return
  }

  let payload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    reply(res, 400, { error: 'invalid json' })
    return
  }

  const expectedRef = `refs/heads/${BRANCH}`
  if (payload?.ref !== expectedRef) {
    log(`push su ${String(payload?.ref)} ignorato (atteso ${expectedRef})`)
    reply(res, 202, { status: 'ignored', reason: 'branch diverso' })
    return
  }

  requestSync(`push ${String(payload?.after ?? '').slice(0, 7)}`)
  reply(res, 202, { status: 'sync requested' })
}

server.listen(PORT, HOST, () => {
  log(`in ascolto su http://${HOST}:${PORT}${PATH} (branch ${BRANCH}, script ${SYNC_SCRIPT})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
