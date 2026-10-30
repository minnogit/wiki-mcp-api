import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthFromEnv, hashToken, runWithPrincipal } from '../src/auth.js'
import { parseWikiConfig } from '../src/config.js'
import { createGitHubClient } from '../src/github.js'
import { FailureRateLimiter, createRequestHandler } from '../src/http-auth.js'
import { PATH_DENIED_MESSAGE, createProposer } from '../src/proposals.js'
import { buildRemoteServer } from '../src/server.js'
import { writeTokenFile } from '../src/token-file.js'
import { FakeGitHub } from './fake-github.js'
import { cleanup, frontmatter, makeService, setupService, type Fixture } from './helpers'
import { callTool, makeTelemetry, openSession, rpc } from './obs-helpers'

// End to end: HTTP vero, MCPServer vero, token per utente (uno con `propose`, uno senza, il
// legacy) e un finto GitHub locale. Nessuna chiamata alla vera API di GitHub.

const T_ANNA = 'tok-anna-propone-0123456789'
const T_BRUNO = 'tok-bruno-sola-lettura-98765'
const T_LEGACY = 'tok-legacy-0000000000'

const FILES: Record<string, string> = {
  'concetti/aperto.md': frontmatter() + '# Aperto\n\nTesto.\n',
  'concetti/segreto.md':
    frontmatter({ extra: 'visibilita: riservata\ngruppi: [legal]' }) + '# Segreto\n\nRISERVATO.\n',
}

let server: http.Server | undefined
let fixture: Fixture | undefined
let fake: FakeGitHub | undefined
let tmp: string | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  await fake?.stop()
  if (fixture) cleanup(fixture)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function start() {
  fake = new FakeGitHub()
  await fake.start()
  fake.seed('wiki/concetti/aperto.md', '# vecchio\n')
  fixture = setupService(FILES)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-prop-http-'))
  const file = path.join(tmp, 'tokens.json')
  writeTokenFile(file, [
    {
      id: 'anna-1',
      user: 'anna',
      groups: ['hr'],
      wikis: ['hr'],
      propose: ['hr'],
      tokenHash: hashToken(T_ANNA),
    },
    { id: 'bruno-1', user: 'bruno', groups: ['hr'], wikis: ['hr'], tokenHash: hashToken(T_BRUNO) },
  ])
  const { authenticator } = createAuthFromEnv(
    { MCP_HTTP_TOKENS_FILE: file, MCP_HTTP_TOKEN: T_LEGACY },
    ['hr'],
  )
  const t = makeTelemetry()
  const svc = makeService(fixture.wikiDir, undefined, { name: 'hr' })
  const proposals = parseWikiConfig(
    [
      {
        name: 'hr',
        wikiPath: 'x',
        proposals: { repo: fake.repo, apiUrl: fake.url, labels: ['wiki'] },
      },
    ],
    fixture.root,
  )[0].proposals!
  const proposer = createProposer({
    svc,
    config: proposals,
    telemetry: t.tel,
    github: createGitHubClient({ apiUrl: fake.url, token: fake.token, repo: fake.repo }),
  })
  const mcp = buildRemoteServer(svc, { exposeRaw: false, telemetry: t.tel, proposer })
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
  return { url, fake, ...t }
}

function parseBody(raw: string): {
  result?: { content?: { text: string }[]; tools?: { name: string }[] }
} {
  const body = raw.startsWith('{')
    ? raw
    : (raw.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6)
  return JSON.parse(body) as never
}
const toolResult = (raw: string): unknown => {
  const text = parseBody(raw).result?.content?.[0]?.text
  return text === undefined ? null : JSON.parse(text)
}

async function as(url: string, token: string) {
  const session = await openSession(url, token)
  return async (name: string, args: unknown = {}) =>
    toolResult(await callTool(url, token, session, name, args))
}

const SECRET_BODY = 'CORPO-DELLA-PROPOSTA-NON-NELL-AUDIT'
const content = frontmatter() + `# Nuova\n\n${SECRET_BODY}\n`

describe('wikiProposePage su HTTP con token diversi', () => {
  it('il tool è elencato; chi ha propose ottiene una PR, chi non ce l ha un diniego, il legacy mai', async () => {
    const { url, fake, events, lines } = await start()

    const session = await openSession(url, T_ANNA)
    const list = parseBody(
      await (
        await rpc(url, T_ANNA, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session)
      ).text(),
    )
    expect(list.result?.tools?.map((t) => t.name)).toContain('wikiProposePage')

    const anna = await as(url, T_ANNA)
    const ok = (await anna('wikiProposePage', {
      path: 'concetti/nuovo.md',
      content,
      rationale: 'Manca la pagina',
      title: 'Pagina nuova',
    })) as {
      prUrl: string
      prNumber: number
      branch: string
      action: string
    }
    expect(ok.action).toBe('create')
    expect(ok.prNumber).toBe(1)
    expect(ok.prUrl).toBe(`https://github.example/${fake.repo}/pull/1`)
    expect(fake.branches.get(ok.branch)!.get('wiki/concetti/nuovo.md')!.content).toBe(content)
    expect(fake.pulls[0]).toMatchObject({ labels: ['wiki'], base: 'main' })
    expect(fake.commits[0].message).toMatch(/Proposed-by: anna \(anna-1\)$/)
    expect(fake.branches.get('main')!.has('wiki/concetti/nuovo.md')).toBe(false)
    expect(fs.existsSync(path.join(fixture!.wikiDir, 'concetti/nuovo.md'))).toBe(false)

    // una modifica di una pagina esistente
    const upd = (await anna('wikiProposePage', { path: 'concetti/aperto.md', content })) as {
      action: string
    }
    expect(upd.action).toBe('update')

    // pagina riservata a un altro gruppo: stessa risposta di un percorso vietato
    const hidden = await anna('wikiProposePage', { path: 'concetti/segreto.md', content })
    const forbidden = await anna('wikiProposePage', { path: '../x.md', content })
    expect(hidden).toEqual({ success: false, error: PATH_DENIED_MESSAGE })
    expect(forbidden).toEqual(hidden)

    // bruno: nessun permesso propose; il legacy nemmeno
    const before = fake.requests.length
    for (const token of [T_BRUNO, T_LEGACY]) {
      const r = (await (
        await as(url, token)
      )('wikiProposePage', { path: 'concetti/altro.md', content })) as {
        success: boolean
        error: string
      }
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/permesso/)
    }
    expect(fake.requests.length).toBe(before)
    expect(fake.pulls).toHaveLength(2)

    // audit: esiti per principal, nessun segreto
    const audit = events('audit').filter((e) => e.tool === 'wikiProposePage')
    expect(audit.map((e) => [e.principal.id, e.outcome, e.reason ?? e.action])).toEqual([
      ['anna-1', 'ok', 'create'],
      ['anna-1', 'ok', 'update'],
      ['anna-1', 'denied', 'visibility'],
      ['anna-1', 'denied', 'path-not-allowed'],
      ['bruno-1', 'denied', 'propose-not-allowed'],
      ['legacy', 'denied', 'propose-not-allowed'],
    ])
    expect(audit[0]).toMatchObject({ prUrl: ok.prUrl, branch: ok.branch })
    const all = JSON.stringify(lines)
    for (const leak of [SECRET_BODY, 'Manca la pagina', fake.token, T_ANNA, T_BRUNO, T_LEGACY]) {
      expect(all).not.toContain(leak)
    }
  })
})
