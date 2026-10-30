import { afterEach, describe, expect, it } from 'vitest'
import {
  OTHER_TOKEN,
  METRICS_TOKEN,
  SECRET_CONTENT,
  SECRET_TOKEN,
  callTool,
  openSession,
  startStack,
  type Stack,
} from './obs-helpers'
import { hashToken } from '../src/auth.js'

let stack: Stack | undefined
afterEach(async () => {
  await stack?.close()
  stack = undefined
})

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers })
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

describe('eventi auth', () => {
  it('token mancante: 401 e evento auth con ip e requestId, senza token', async () => {
    stack = await startStack()
    const res = await get(`${stack.base}/mcp/hr`)
    expect(res.status).toBe(401)
    const [e] = stack.events('auth')
    expect(e).toMatchObject({
      event: 'auth',
      reason: 'missing-token',
      status: 401,
      endpoint: 'mcp',
    })
    expect(e.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(e.ip).toMatch(/127\.0\.0\.1/)
  })

  it('token errato: 401 invalid-token; il token presentato non compare in nessuna riga', async () => {
    stack = await startStack()
    const res = await get(`${stack.base}/mcp/hr`, bearer('token-sbagliato-ABC123'))
    expect(res.status).toBe(401)
    expect(stack.events('auth')[0].reason).toBe('invalid-token')
    expect(stack.lines.join('\n')).not.toContain('token-sbagliato-ABC123')
  })

  it('token scaduto: 401 con motivo interno expired-token, risposta uguale a quella per token errato', async () => {
    stack = await startStack()
    // il token di alice è valido: ne creiamo uno scaduto riscrivendo il file? più semplice: autenticatore dedicato
    const { createAuthenticator } = await import('../src/auth.js')
    const { FailureRateLimiter, createRequestHandler } = await import('../src/http-auth.js')
    const http = await import('node:http')
    const { makeTelemetry } = await import('./obs-helpers')
    const t = makeTelemetry()
    const auth = createAuthenticator({
      entries: () => [
        {
          id: 'old-1',
          user: 'old',
          wikis: '*',
          tokenHash: hashToken('tok-scaduto'),
          expiresAt: '2000-01-01T00:00:00Z',
        },
      ],
    })
    const handler = createRequestHandler({
      auth,
      telemetry: t.tel,
      limiter: new FailureRateLimiter({ maxFailures: 10, windowMs: 1000 }),
      wikis: ['hr'],
      mcp: () => Promise.resolve(),
    })
    const srv = http.createServer((q, r) => void handler(q, r))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    const expired = await get(`http://127.0.0.1:${port}/mcp/hr`, bearer('tok-scaduto'))
    const wrong = await get(`http://127.0.0.1:${port}/mcp/hr`, bearer('altro'))
    srv.close()
    expect(expired.status).toBe(401)
    expect(await expired.text()).toBe(await wrong.text())
    expect(t.events('auth').map((e) => e.reason)).toEqual(['expired-token', 'invalid-token'])
    expect(t.lines.join('\n')).not.toContain('tok-scaduto')
  })

  it('rate limit: 429 con motivo rate-limited', async () => {
    stack = await startStack({ rateMax: 2 })
    await get(`${stack.base}/mcp/hr`, bearer('x'))
    await get(`${stack.base}/mcp/hr`, bearer('y'))
    const res = await get(`${stack.base}/mcp/hr`, bearer('z'))
    expect(res.status).toBe(429)
    const events = stack.events('auth')
    expect(events.map((e) => e.reason)).toEqual(['invalid-token', 'invalid-token', 'rate-limited'])
    expect(events[2].status).toBe(429)
    expect(events[2].retryAfterSeconds).toBeGreaterThan(0)
  })

  it('wiki non abilitata: evento wiki-not-allowed, ma risposta identica a una wiki inesistente', async () => {
    stack = await startStack()
    const notAllowed = await get(`${stack.base}/mcp/it`, bearer(SECRET_TOKEN)) // alice ha solo hr
    const unknown = await get(`${stack.base}/mcp/nonesiste`, bearer(SECRET_TOKEN))
    expect(notAllowed.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await notAllowed.text()).toBe(await unknown.text())
    const headersOf = (r: Response) => [...r.headers].filter(([k]) => k !== 'date').sort()
    expect(headersOf(notAllowed)).toEqual(headersOf(unknown))
    const events = stack.events('auth')
    expect(events[0]).toMatchObject({
      reason: 'wiki-not-allowed',
      status: 404,
      requestedWiki: 'it',
      principal: { id: 'alice-1', user: 'alice' },
    })
    expect(events[1].reason).toBe('wiki-unknown')
  })

  it('niente eventi né metriche per /healthz', async () => {
    stack = await startStack({ metricsToken: METRICS_TOKEN })
    const res = await get(`${stack.base}/healthz`)
    expect(res.status).toBe(200)
    expect(stack.lines).toEqual([])
    const m = await (await get(`${stack.base}/metrics`, bearer(METRICS_TOKEN))).text()
    expect(m).not.toMatch(/http_requests_total\{status="200"\} [2-9]/)
  })
})

describe('/metrics', () => {
  it('senza MCP_METRICS_TOKEN non è esposto: 404, come un percorso qualunque', async () => {
    stack = await startStack()
    const res = await get(`${stack.base}/metrics`, bearer('qualsiasi'))
    expect(res.status).toBe(404)
    expect(stack.events('auth')).toEqual([])
  })

  it('con token: 401 se manca o è sbagliato, 401 anche con un token MCP valido', async () => {
    stack = await startStack({ metricsToken: METRICS_TOKEN })
    expect((await get(`${stack.base}/metrics`)).status).toBe(401)
    expect((await get(`${stack.base}/metrics`, bearer('no'))).status).toBe(401)
    expect((await get(`${stack.base}/metrics`, bearer(OTHER_TOKEN))).status).toBe(401)
    const ev = stack.events('auth')
    expect(ev.map((e) => [e.reason, e.endpoint])).toEqual([
      ['missing-token', 'metrics'],
      ['invalid-token', 'metrics'],
      ['invalid-token', 'metrics'],
    ])
    expect(stack.lines.join('\n')).not.toContain(METRICS_TOKEN)
  })

  it('i contatori cambiano dopo chiamate reali (e restano a cardinalità chiusa)', async () => {
    stack = await startStack({ metricsToken: METRICS_TOKEN })
    const metrics = async () => (await get(`${stack!.base}/metrics`, bearer(METRICS_TOKEN))).text()
    const before = await metrics()
    expect(before).toContain('# TYPE wiki_mcp_wiki_pages gauge')
    expect(before).toContain('wiki_mcp_wiki_pages{wiki="hr"} 2')
    expect(before).toContain('wiki_mcp_wiki_pages{wiki="it"} 2')
    expect(before).not.toContain('wiki_mcp_tool_calls_total')

    const url = `${stack.base}/mcp/hr`
    const s = await openSession(url, SECRET_TOKEN)
    await callTool(url, SECRET_TOKEN, s, 'wikiSearch', { q: 'uno' })
    await callTool(url, SECRET_TOKEN, s, 'wikiSearch', { q: 'due' })
    await callTool(url, SECRET_TOKEN, s, 'wikiReadPage', { slug: 'non/esiste' })
    await get(`${stack.base}/mcp/hr`, bearer('sbagliato'))

    const after = await metrics()
    expect(after).toContain('wiki_mcp_tool_calls_total{wiki="hr",tool="wikiSearch",outcome="ok"} 2')
    expect(after).toContain(
      'wiki_mcp_tool_calls_total{wiki="hr",tool="wikiReadPage",outcome="error"} 1',
    )
    expect(after).toContain('wiki_mcp_tool_duration_seconds_count{wiki="hr",tool="wikiSearch"} 2')
    expect(after).toMatch(
      /wiki_mcp_tool_duration_seconds_bucket\{wiki="hr",tool="wikiSearch",le="\+Inf"\} 2/,
    )
    expect(after).toContain('wiki_mcp_auth_failures_total{reason="invalid-token"} 1')
    expect(after).toMatch(/wiki_mcp_http_requests_total\{status="200"\} \d+/)
    expect(after).toMatch(/wiki_mcp_http_requests_total\{status="401"\} 1/)
    // nessun valore dell'utente nelle etichette
    expect(after).not.toMatch(/alice|uno|due|non\/esiste|sbagliato/)
  })
})

describe('privacy end-to-end: nessun segreto in nessuna riga di log', () => {
  it('token, hash, header Authorization e contenuti di scrittura non compaiono', async () => {
    stack = await startStack({ metricsToken: METRICS_TOKEN })
    const url = `${stack.base}/mcp/hr`
    const s = await openSession(url, SECRET_TOKEN)
    await callTool(url, SECRET_TOKEN, s, 'wikiReadPage', { slug: 'concetti/uno' })
    await callTool(url, SECRET_TOKEN, s, 'wikiSearch', { q: 'uno', topK: 3 })
    await callTool(url, SECRET_TOKEN, s, 'wikiReadPage', { slug: 5 }) // input non valido
    await get(url, bearer('Bearer-finto-999'))
    await get(`${stack.base}/mcp/it`, bearer(SECRET_TOKEN)) // wiki non abilitata
    await get(`${stack.base}/metrics`, bearer('xx'))
    await stack.servers.get('hr')!.close?.()
    const all = stack.lines.join('\n')
    expect(stack.lines.length).toBeGreaterThanOrEqual(5)
    for (const secret of [
      SECRET_TOKEN,
      OTHER_TOKEN,
      METRICS_TOKEN,
      hashToken(SECRET_TOKEN),
      hashToken(OTHER_TOKEN),
      hashToken(SECRET_TOKEN).slice(7),
      'Bearer-finto-999',
      SECRET_CONTENT,
      'Authorization',
    ]) {
      expect(all).not.toContain(secret)
    }
  })
})
