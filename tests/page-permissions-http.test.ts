import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthFromEnv, hashToken, runWithPrincipal } from '../src/auth.js'
import { FailureRateLimiter, createRequestHandler } from '../src/http-auth.js'
import { buildRemoteServer } from '../src/server.js'
import { writeTokenFile } from '../src/token-file.js'
import { cleanup, frontmatter, makeService, setupService, type Fixture } from './helpers'
import { callTool, makeTelemetry, openSession } from './obs-helpers'

// End to end su HTTP vero, MCPServer vero e service creato come in src/http.ts (nessun principal
// esplicito: lo legge dal contesto della richiesta). Due token con insiemi di pagine diversi.

const T_HR = 'tok-hr-anna-0123456789'
const T_FUORI = 'tok-it-bruno-9876543210'
const T_ADMIN = 'tok-admin-ada-5555555555'
const T_LEGACY = 'tok-legacy-0000000000'

const FILES: Record<string, string> = {
  'concetti/aperto.md':
    frontmatter() + '# Aperto\n\nFatture e il [[concetti/buste-paga]] di tutti.\n',
  'concetti/buste-paga.md':
    frontmatter({ extra: 'visibilita: riservata\ngruppi: [hr]' }) +
    '# Buste paga\n\nCONTENUTO-RISERVATO-DELLE-BUSTE: fatture e stipendi.\n',
  'concetti/solo-admin.md':
    frontmatter({ extra: 'visibilita: riservata' }) + '# Solo admin\n\nFatture riservate.\n',
}

let server: http.Server | undefined
let fixture: Fixture | undefined
let tmp: string | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  if (fixture) cleanup(fixture)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function start() {
  fixture = setupService(FILES)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-perm-'))
  const file = path.join(tmp, 'tokens.json')
  writeTokenFile(file, [
    { id: 'anna-1', user: 'anna', groups: ['hr'], wikis: ['hr'], tokenHash: hashToken(T_HR) },
    { id: 'bruno-1', user: 'bruno', groups: ['it'], wikis: ['hr'], tokenHash: hashToken(T_FUORI) },
    { id: 'ada-1', user: 'ada', groups: ['admin'], wikis: ['hr'], tokenHash: hashToken(T_ADMIN) },
  ])
  const { authenticator } = createAuthFromEnv(
    { MCP_HTTP_TOKENS_FILE: file, MCP_HTTP_TOKEN: T_LEGACY },
    ['hr'],
  )
  const t = makeTelemetry()
  const mcp = buildRemoteServer(makeService(fixture.wikiDir, undefined, { name: 'hr' }), {
    exposeRaw: false,
    telemetry: t.tel,
  })
  const handler = createRequestHandler({
    auth: authenticator,
    limiter: new FailureRateLimiter({ maxFailures: 100, windowMs: 60_000 }),
    telemetry: t.tel,
    wikis: ['hr'],
    mcp: (_wiki, url, req, res, principal) =>
      runWithPrincipal(principal, () => mcp.startHTTP({ url, httpPath: url.pathname, req, res })),
  })
  server = http.createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/hr`
  return { url, ...t }
}

// Il risultato del tool è il testo JSON dentro la risposta MCP (JSON semplice o SSE).
function toolResult(raw: string): unknown {
  const body = raw.startsWith('{')
    ? raw
    : (raw.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6)
  const text = (JSON.parse(body) as { result?: { content?: { text: string }[] } }).result
    ?.content?.[0]?.text
  return text === undefined ? null : JSON.parse(text)
}

async function as(url: string, token: string) {
  const session = await openSession(url, token)
  return async (name: string, args: unknown = {}) =>
    toolResult(await callTool(url, token, session, name, args))
}

describe('permessi per pagina su HTTP, con token diversi', () => {
  it('utente del gruppo, utente fuori gruppo, admin e token legacy vedono insiemi diversi', async () => {
    const { url } = await start()
    const slugsOf = async (token: string) =>
      ((await (await as(url, token))('wikiListPages')) as { slug: string }[])
        .map((p) => p.slug)
        .sort()

    expect(await slugsOf(T_HR)).toEqual(['concetti/aperto', 'concetti/buste-paga'])
    expect(await slugsOf(T_FUORI)).toEqual(['concetti/aperto'])
    expect(await slugsOf(T_LEGACY)).toEqual(['concetti/aperto']) // legacy: nessun gruppo
    expect(await slugsOf(T_ADMIN)).toEqual([
      'concetti/aperto',
      'concetti/buste-paga',
      'concetti/solo-admin',
    ])
  })

  it('search, status, graph e read rispettano il principal della richiesta', async () => {
    const { url } = await start()
    const hr = await as(url, T_HR)
    const fuori = await as(url, T_FUORI)

    const found = async (c: typeof hr) =>
      ((await c('wikiSearch', { q: 'fatture' })) as { slug: string }[]).map((p) => p.slug).sort()
    expect(await found(hr)).toEqual(['concetti/aperto', 'concetti/buste-paga'])
    expect(await found(fuori)).toEqual(['concetti/aperto'])

    expect(((await hr('wikiStatus')) as { totalPages: number }).totalPages).toBe(2)
    expect(((await fuori('wikiStatus')) as { totalPages: number }).totalPages).toBe(1)

    const gf = (await fuori('wikiGraph')) as { forward: Record<string, string[]> }
    expect(Object.keys(gf.forward)).toEqual(['concetti/aperto'])

    expect(await hr('wikiReadPage', { slug: 'concetti/buste-paga' })).toMatchObject({
      title: 'Buste paga',
    })
    expect(await fuori('wikiReadPage', { slug: 'concetti/buste-paga' })).toEqual({
      error: 'Pagina non trovata: concetti/buste-paga',
    })
    expect(await fuori('wikiReadPage', { slug: 'concetti/non-esiste' })).toEqual({
      error: 'Pagina non trovata: concetti/non-esiste',
    })
  })

  it('la stessa sessione usata con un altro token vede l insieme di quel token', async () => {
    const { url } = await start()
    const session = await openSession(url, T_HR)
    const asFuori = toolResult(
      await callTool(url, T_FUORI, session, 'wikiReadPage', { slug: 'concetti/buste-paga' }),
    )
    expect(asFuori).toEqual({ error: 'Pagina non trovata: concetti/buste-paga' })
  })

  it('la risposta HTTP a una pagina negata è identica a quella per una inesistente', async () => {
    const { url } = await start()
    const session = await openSession(url, T_FUORI)
    const negata = await callTool(url, T_FUORI, session, 'wikiReadPage', {
      slug: 'concetti/buste-paga',
    })
    const inesistente = await callTool(url, T_FUORI, session, 'wikiReadPage', {
      slug: 'concetti/buste-pagx',
    })
    // stessa lunghezza di slug: le due risposte differiscono solo per lo slug richiesto
    expect(negata.replace('buste-paga', 'buste-pagx')).toBe(inesistente)
  })

  it('l audit ha denied solo per la lettura di una riservata esistente, con principal e motivo, senza contenuti', async () => {
    const { url, events, lines } = await start()
    const fuori = await as(url, T_FUORI)
    await fuori('wikiReadPage', { slug: 'concetti/buste-paga' })
    await fuori('wikiReadPage', { slug: 'concetti/non-esiste' })
    await fuori('wikiSearch', { q: 'fatture' })
    const hr = await as(url, T_HR)
    await hr('wikiReadPage', { slug: 'concetti/buste-paga' })

    const audit = events('audit')
    expect(audit.map((e) => [e.principal.user, e.tool, e.outcome, e.reason])).toEqual([
      ['bruno', 'wikiReadPage', 'denied', 'visibility'],
      ['bruno', 'wikiReadPage', 'error', undefined],
      ['bruno', 'wikiSearch', 'ok', undefined],
      ['anna', 'wikiReadPage', 'ok', undefined],
    ])
    const text = lines.join('\n')
    for (const secret of [T_HR, T_FUORI, T_ADMIN, T_LEGACY, 'CONTENUTO-RISERVATO', 'sha256:'])
      expect(text).not.toContain(secret)
  })
})
