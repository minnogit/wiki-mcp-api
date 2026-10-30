import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MCPServer } from '@mastra/mcp'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthenticator, hashToken } from '../src/auth.js'
import { FailureRateLimiter, createRequestHandler } from '../src/http-auth.js'
import { parseTokenFile } from '../src/token-file.js'
import { buildRemoteServer } from '../src/server.js'
import { frontmatter, makeService, writeTree } from './helpers'

const AUTH = { Authorization: 'Bearer tok' }
const MCP_HEADERS = {
  ...AUTH,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

let httpServer: http.Server | undefined
const tmp: string[] = []

afterEach(async () => {
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()))
  httpServer = undefined
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface Calls {
  wiki: string
  path: string
}

// Router con gestore MCP finto: verifica solo a quale wiki arriva la richiesta.
async function startFake(names: string[]): Promise<{ base: string; calls: Calls[] }> {
  const calls: Calls[] = []
  const handler = createRequestHandler({
    token: 'tok',
    limiter: new FailureRateLimiter({ maxFailures: 100, windowMs: 60_000 }),
    wikis: names,
    mcp: (wiki, url, _req, res) => {
      calls.push({ wiki, path: url.pathname })
      res.writeHead(200).end(wiki)
      return Promise.resolve()
    },
  })
  httpServer = http.createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`, calls }
}

describe('routing HTTP multi-wiki', () => {
  it('/mcp/<name> instrada alla wiki col nome giusto', async () => {
    const { base, calls } = await startFake(['hr', 'it'])
    expect(await (await fetch(`${base}/mcp/hr`, { headers: AUTH })).text()).toBe('hr')
    expect(await (await fetch(`${base}/mcp/it`, { headers: AUTH })).text()).toBe('it')
    expect(calls).toEqual([
      { wiki: 'hr', path: '/mcp/hr' },
      { wiki: 'it', path: '/mcp/it' },
    ])
  })

  it('/mcp è un alias valido solo con una wiki sola, accanto a /mcp/<name>', async () => {
    const { base, calls } = await startFake(['hr'])
    expect((await fetch(`${base}/mcp`, { headers: AUTH })).status).toBe(200)
    expect((await fetch(`${base}/mcp/hr`, { headers: AUTH })).status).toBe(200)
    expect(calls.map((c) => c.wiki)).toEqual(['hr', 'hr'])
  })

  it('con più wiki /mcp risponde 404 (dopo l autenticazione) senza elencare i nomi', async () => {
    const { base, calls } = await startFake(['hr', 'it'])
    const res = await fetch(`${base}/mcp`, { headers: AUTH })
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).not.toMatch(/hr|it\b/)
    expect(calls).toEqual([])
  })

  it('nome sconosciuto: 404 a token valido, senza rivelare i nomi esistenti', async () => {
    const { base, calls } = await startFake(['hr', 'it'])
    const res = await fetch(`${base}/mcp/segreta`, { headers: AUTH })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toMatch(/hr|\bit\b/)
    expect(calls).toEqual([])
  })

  it('il 401 viene prima del 404: senza token nomi esistenti e inesistenti sono indistinguibili', async () => {
    const { base, calls } = await startFake(['hr', 'it'])
    const bad = { headers: { Authorization: 'Bearer no' } }
    for (const p of ['/mcp/hr', '/mcp/segreta', '/mcp']) {
      const none = await fetch(`${base}${p}`)
      const wrong = await fetch(`${base}${p}`, bad)
      expect(none.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(await none.text()).toBe(await wrong.text())
    }
    expect(calls).toEqual([])
  })

  it('i token errati su un nome sconosciuto contano per il rate limit', async () => {
    const calls: string[] = []
    const handler = createRequestHandler({
      token: 'tok',
      limiter: new FailureRateLimiter({ maxFailures: 2, windowMs: 60_000 }),
      wikis: ['hr', 'it'],
      mcp: (wiki, _u, _r, res) => {
        calls.push(wiki)
        res.writeHead(200).end()
        return Promise.resolve()
      },
    })
    httpServer = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    expect((await fetch(`${base}/mcp/xx`)).status).toBe(401)
    expect((await fetch(`${base}/mcp/hr`)).status).toBe(401)
    expect((await fetch(`${base}/mcp/hr`, { headers: AUTH })).status).toBe(429)
    expect(calls).toEqual([])
  })

  it('altri percorsi (anche sotto /mcp/) restano 404 e /healthz non cambia', async () => {
    const { base } = await startFake(['hr', 'it'])
    for (const p of ['/', '/altro', '/mcp/hr/extra', '/mcp/', '/mcphr', '/mcp%2Fhr']) {
      expect((await fetch(`${base}${p}`, { headers: AUTH })).status).toBe(404)
    }
    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
  })

  it('il nome non viene decodificato né confrontato in modo ambiguo', async () => {
    const { base } = await startFake(['hr'])
    expect((await fetch(`${base}/mcp/h%72`, { headers: AUTH })).status).toBe(404)
    expect((await fetch(`${base}/mcp/HR`, { headers: AUTH })).status).toBe(404)
    expect((await fetch(`${base}/mcp/constructor`, { headers: AUTH })).status).toBe(404)
    expect((await fetch(`${base}/mcp/__proto__`, { headers: AUTH })).status).toBe(404)
  })
})

// Server MCP veri, uno per wiki, dietro lo stesso router: verifica che ogni endpoint serva
// davvero i contenuti della propria wiki.
describe('end-to-end con MCPServer reali', () => {
  function makeWiki(name: string, title: string): MCPServer {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wiki-mcp-http-${name}-`))
    tmp.push(root)
    writeTree(path.join(root, 'wiki'), { 'x.md': frontmatter() + `# ${title}\n\nCorpo.` })
    const svc = makeService(path.join(root, 'wiki'), path.join(root, 'raw'), { name })
    return buildRemoteServer(svc, { exposeRaw: false })
  }

  async function rpc(base: string, p: string, body: unknown, session?: string) {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    })
    return res
  }

  // la risposta può essere JSON o un evento SSE con una riga `data: {...}`
  async function parse(res: Response): Promise<{ result?: Record<string, unknown> }> {
    const text = await res.text()
    const data = text.startsWith('{')
      ? text
      : (text.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6)
    return JSON.parse(data) as { result?: Record<string, unknown> }
  }

  async function readTitle(base: string, p: string): Promise<string> {
    const init = await rpc(base, p, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    })
    expect(init.status).toBe(200)
    const session = init.headers.get('mcp-session-id') ?? undefined
    await parse(init)
    await rpc(base, p, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    const call = await rpc(
      base,
      p,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'wikiReadPage', arguments: { slug: 'x' } },
      },
      session,
    )
    const out = await parse(call)
    return JSON.stringify(out.result)
  }

  async function startReal(servers: Map<string, MCPServer>) {
    const handler = createRequestHandler({
      token: 'tok',
      limiter: new FailureRateLimiter({ maxFailures: 100, windowMs: 60_000 }),
      wikis: [...servers.keys()],
      mcp: (wiki, url, req, res) =>
        servers.get(wiki)!.startHTTP({ url, httpPath: url.pathname, req, res }),
    })
    httpServer = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
  }

  it('ogni endpoint serve i contenuti della propria wiki', async () => {
    const base = await startReal(
      new Map([
        ['hr', makeWiki('hr', 'Pagina HR')],
        ['it', makeWiki('it', 'Pagina IT')],
      ]),
    )
    const hr = await readTitle(base, '/mcp/hr')
    const it = await readTitle(base, '/mcp/it')
    expect(hr).toContain('Pagina HR')
    expect(hr).not.toContain('Pagina IT')
    expect(it).toContain('Pagina IT')
    expect(it).not.toContain('Pagina HR')
  })

  it('con una wiki sola l alias /mcp serve la stessa wiki di /mcp/<name>', async () => {
    const base = await startReal(new Map([['solo', makeWiki('solo', 'Pagina Solo')]]))
    expect(await readTitle(base, '/mcp')).toContain('Pagina Solo')
    expect(await readTitle(base, '/mcp/solo')).toContain('Pagina Solo')
  })
})

// Token per utente: ogni principal vede solo le wiki che gli sono abilitate.
describe('routing con token per utente', () => {
  const ALICE = { Authorization: 'Bearer tok-alice' }
  const OLD = { Authorization: 'Bearer tok-old' }

  async function startUsers(now = () => Date.parse('2026-01-01')) {
    const entries = parseTokenFile([
      { id: 'alice', user: 'alice', wikis: ['hr'], tokenHash: hashToken('tok-alice') },
      { id: 'root', user: 'root', wikis: '*', tokenHash: hashToken('tok-root') },
      {
        id: 'old',
        user: 'old',
        wikis: '*',
        tokenHash: hashToken('tok-old'),
        expiresAt: '2020-01-01T00:00:00Z',
      },
    ])
    const seen: string[] = []
    const handler = createRequestHandler({
      auth: createAuthenticator({ entries: () => entries, now }),
      limiter: new FailureRateLimiter({ maxFailures: 100, windowMs: 60_000 }),
      wikis: ['hr', 'it'],
      mcp: (wiki, _u, _r, res, principal) => {
        seen.push(`${principal.id}@${wiki}`)
        res.writeHead(200).end(wiki)
        return Promise.resolve()
      },
    })
    httpServer = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    return { base: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`, seen }
  }

  it('il principal arriva al gestore MCP insieme alla wiki', async () => {
    const { base, seen } = await startUsers()
    expect((await fetch(`${base}/mcp/hr`, { headers: ALICE })).status).toBe(200)
    const root = { Authorization: 'Bearer tok-root' }
    expect((await fetch(`${base}/mcp/it`, { headers: root })).status).toBe(200)
    expect(seen).toEqual(['alice@hr', 'root@it'])
  })

  it('wiki non abilitata: 404 identico a wiki inesistente (stato, corpo, header)', async () => {
    const { base, seen } = await startUsers()
    const notEnabled = await fetch(`${base}/mcp/it`, { headers: ALICE })
    const missing = await fetch(`${base}/mcp/fantasma`, { headers: ALICE })
    expect(notEnabled.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await notEnabled.text()).toBe(await missing.text())
    const headers = (r: Response) =>
      [...r.headers].filter(([k]) => k !== 'date').sort(([a], [b]) => a.localeCompare(b))
    expect(headers(notEnabled)).toEqual(headers(missing))
    expect(seen).toEqual([])
  })

  it('token scaduto: 401 come uno sconosciuto', async () => {
    const { base, seen } = await startUsers()
    const expired = await fetch(`${base}/mcp/hr`, { headers: OLD })
    const unknown = await fetch(`${base}/mcp/hr`, { headers: { Authorization: 'Bearer boh' } })
    expect(expired.status).toBe(401)
    expect(await expired.text()).toBe(await unknown.text())
    expect(seen).toEqual([])
  })

  it('un token scaduto conta come fallimento nel rate limit', async () => {
    const entries = parseTokenFile([
      {
        id: 'old',
        user: 'old',
        wikis: '*',
        tokenHash: hashToken('tok-old'),
        expiresAt: '2020-01-01T00:00:00Z',
      },
    ])
    const handler = createRequestHandler({
      auth: createAuthenticator({ entries: () => entries }),
      limiter: new FailureRateLimiter({ maxFailures: 1, windowMs: 60_000 }),
      wikis: ['hr'],
      mcp: (_w, _u, _r, res) => {
        res.writeHead(200).end()
        return Promise.resolve()
      },
    })
    httpServer = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    expect((await fetch(`${base}/mcp/hr`, { headers: OLD })).status).toBe(401)
    expect((await fetch(`${base}/mcp/hr`, { headers: OLD })).status).toBe(429)
  })

  it('l alias /mcp con una wiki non abilitata al principal è 404', async () => {
    const entries = parseTokenFile([
      { id: 'a', user: 'a', wikis: ['altra'], tokenHash: hashToken('tok-a') },
    ])
    const handler = createRequestHandler({
      auth: createAuthenticator({ entries: () => entries }),
      limiter: new FailureRateLimiter({ maxFailures: 100, windowMs: 60_000 }),
      wikis: ['solo'],
      mcp: (_w, _u, _r, res) => {
        res.writeHead(200).end()
        return Promise.resolve()
      },
    })
    httpServer = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    expect(
      (await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer tok-a' } })).status,
    ).toBe(404)
  })
})
