import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTool } from '@mastra/core/tools'
import { MCPServer } from '@mastra/mcp'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { currentPrincipal, createAuthFromEnv, runWithPrincipal } from '../src/auth.js'
import { FailureRateLimiter, createRequestHandler } from '../src/http-auth.js'
import { writeTokenFile } from '../src/token-file.js'
import { hashToken } from '../src/auth.js'

// Dimostra il contratto del Principal: dentro l'esecuzione di un tool, servito da un MCPServer
// vero di @mastra/mcp dietro il router HTTP, `currentPrincipal()` restituisce l'identità della
// richiesta che ha chiamato il tool. Il contesto async si propaga attraverso la gestione della
// richiesta della libreria (transport, sessione, handler del tool).

const whoami = createTool({
  id: 'whoami',
  description: 'Restituisce il principal visto dentro il tool',
  inputSchema: z.object({}),
  execute: async () => {
    // un await vero, per attraversare almeno un confine asincrono dentro il tool
    await new Promise((r) => setTimeout(r, 5))
    return { principal: currentPrincipal() ?? null }
  },
})

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

let httpServer: http.Server | undefined
let tmp: string | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()))
  httpServer = undefined
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

async function start(): Promise<string> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-principal-'))
  const file = path.join(tmp, 'tokens.json')
  writeTokenFile(file, [
    {
      id: 'alice-1',
      user: 'alice',
      groups: ['hr'],
      wikis: ['hr'],
      tokenHash: hashToken('tok-alice'),
    },
    { id: 'bob-1', user: 'bob', wikis: '*', tokenHash: hashToken('tok-bob') },
  ])
  const { authenticator } = createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: file }, ['hr'])
  const server = new MCPServer({
    id: 'probe',
    name: 'probe',
    version: '0.0.0',
    tools: { whoami },
  })
  const handler = createRequestHandler({
    auth: authenticator,
    limiter: new FailureRateLimiter({ maxFailures: 100, windowMs: 60_000 }),
    wikis: ['hr'],
    mcp: (_wiki, url, req, res, principal) =>
      runWithPrincipal(principal, () =>
        server.startHTTP({ url, httpPath: url.pathname, req, res }),
      ),
  })
  httpServer = http.createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp/hr`
}

async function rpc(url: string, token: string, body: unknown, session?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      Authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function parse(res: Response): Promise<{ result?: { content?: { text: string }[] } }> {
  const text = await res.text()
  const data = text.startsWith('{')
    ? text
    : (text.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6)
  return JSON.parse(data) as { result?: { content?: { text: string }[] } }
}

async function openSession(url: string, token: string): Promise<string> {
  const init = await rpc(url, token, {
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
  const session = init.headers.get('mcp-session-id')!
  await init.text()
  await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  return session
}

async function callWhoami(url: string, token: string, session: string) {
  const res = await rpc(
    url,
    token,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    session,
  )
  const out = await parse(res)
  const text = out.result?.content?.[0]?.text ?? 'null'
  return (JSON.parse(text) as { principal: unknown }).principal
}

describe('propagazione del Principal dentro i tool (end-to-end con @mastra/mcp)', () => {
  it('il tool vede l identità del token che ha fatto la richiesta', async () => {
    const url = await start()
    const sa = await openSession(url, 'tok-alice')
    const sb = await openSession(url, 'tok-bob')
    expect(await callWhoami(url, 'tok-alice', sa)).toEqual({
      id: 'alice-1',
      user: 'alice',
      groups: ['hr'],
      wikis: ['hr'],
      propose: [],
    })
    expect(await callWhoami(url, 'tok-bob', sb)).toEqual({
      id: 'bob-1',
      user: 'bob',
      groups: [],
      wikis: '*',
      propose: [],
    })
  })

  it('l identità è quella della singola richiesta, non quella che ha aperto la sessione', async () => {
    const url = await start()
    const session = await openSession(url, 'tok-alice')
    // stessa sessione, token di bob: il tool deve vedere bob, mai un principal «ereditato»
    const seen = (await callWhoami(url, 'tok-bob', session)) as { user: string }
    expect(seen.user).toBe('bob')
  })

  it('fuori da una richiesta HTTP (stdio) non c è principal: locale, fiducia piena', () => {
    expect(currentPrincipal()).toBeUndefined()
  })
})
