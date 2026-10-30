import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MCPServer } from '@mastra/mcp'
import { createAuditor } from '../src/audit.js'
import { createAuthFromEnv, hashToken, runWithPrincipal } from '../src/auth.js'
import { FailureRateLimiter, createRequestHandler } from '../src/http-auth.js'
import { createLogger, type LogFormat } from '../src/log.js'
import { Metrics } from '../src/metrics.js'
import { buildRemoteServer, registerWikiGauge } from '../src/server.js'
import type { Telemetry } from '../src/telemetry.js'
import { writeTokenFile } from '../src/token-file.js'
import { cleanup, frontmatter, makeService, setupService, type Fixture } from './helpers'

export interface Ev {
  ts: string
  level: string
  event: string
  requestId: string
  principal: { id: string; user: string }
  wiki: string
  tool: string
  outcome: string
  durationMs: number
  args: Record<string, unknown>
  resultSize?: number
  error?: string
  reason?: string
  ip?: string
  status?: number
  endpoint?: string
  requestedWiki?: string
  retryAfterSeconds?: number
  [k: string]: unknown
}

// Telemetria di prova: le righe prodotte finiscono in un array, da ispezionare come un operatore
// ispezionerebbe il journal.
export function makeTelemetry(
  opts: { format?: LogFormat; queryMaxChars?: number; auditor?: boolean } = {},
): { tel: Telemetry; lines: string[]; events: (name?: string) => Ev[] } {
  const lines: string[] = []
  const logger = createLogger({ format: opts.format ?? 'json', sink: (l) => lines.push(l) })
  const tel: Telemetry = {
    logger,
    auditor: createAuditor(logger),
    metrics: new Metrics(),
    queryMaxChars: opts.queryMaxChars ?? 100,
  }
  const events = (name?: string) =>
    lines.map((l) => JSON.parse(l) as Ev).filter((e) => name === undefined || e.event === name)
  return { tel, lines, events }
}

export const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

export const SECRET_TOKEN = 'tok-segretissimo-alice-0123456789'
export const OTHER_TOKEN = 'tok-bob-segreto-9876543210'
export const METRICS_TOKEN = 'metrics-segreto-abcdef'
export const SECRET_CONTENT = 'CONTENUTO-RISERVATO-DELLA-PAGINA-xyzzy'

export interface Stack {
  base: string
  tel: Telemetry
  lines: string[]
  events: (name?: string) => Ev[]
  servers: Map<string, MCPServer>
  close: () => Promise<void>
}

// Server HTTP vero come src/http.ts: due wiki (hr, it), router, MCPServer per wiki, telemetria.
// alice può solo `hr`, bob tutte.
export async function startStack(
  opts: { metricsToken?: string; exposeRaw?: boolean; rateMax?: number } = {},
): Promise<Stack> {
  const fixtures: Fixture[] = ['hr', 'it'].map((name) =>
    setupService({
      'concetti/uno.md': frontmatter() + `# Uno ${name}\n\nTesto ${name}.\n`,
      'concetti/due.md': frontmatter() + '# Due\n\nAltro.\n',
    }),
  )
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-obs-'))
  const file = path.join(tmp, 'tokens.json')
  writeTokenFile(file, [
    { id: 'alice-1', user: 'alice', wikis: ['hr'], tokenHash: hashToken(SECRET_TOKEN) },
    { id: 'bob-1', user: 'bob', wikis: '*', tokenHash: hashToken(OTHER_TOKEN) },
  ])
  const { authenticator } = createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: file }, ['hr', 'it'])
  const { tel, lines, events } = makeTelemetry()
  const servers = new Map<string, MCPServer>()
  const names = ['hr', 'it']
  names.forEach((name, i) => {
    const svc = makeService(fixtures[i].wikiDir, fixtures[i].rawDir, { name })
    registerWikiGauge(svc, tel)
    servers.set(name, buildRemoteServer(svc, { exposeRaw: opts.exposeRaw ?? true, telemetry: tel }))
  })
  const handler = createRequestHandler({
    auth: authenticator,
    limiter: new FailureRateLimiter({ maxFailures: opts.rateMax ?? 100, windowMs: 60_000 }),
    telemetry: tel,
    metricsToken: opts.metricsToken,
    wikis: names,
    mcp: (wiki, url, req, res, principal) =>
      runWithPrincipal(principal, () =>
        servers.get(wiki)!.startHTTP({ url, httpPath: url.pathname, req, res }),
      ),
  })
  const server = http.createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tel,
    lines,
    events,
    servers,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fixtures.forEach(cleanup)
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

export async function rpc(url: string, token: string, body: unknown, session?: string) {
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

export async function openSession(url: string, token: string): Promise<string> {
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
  if (init.status !== 200) throw new Error(`initialize: ${init.status}`)
  const session = init.headers.get('mcp-session-id')!
  await init.text()
  await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  return session
}

export async function callTool(
  url: string,
  token: string,
  session: string,
  name: string,
  args: unknown,
): Promise<string> {
  const res = await rpc(
    url,
    token,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    session,
  )
  return res.text()
}
