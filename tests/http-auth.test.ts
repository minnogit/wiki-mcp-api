import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FailureRateLimiter,
  createRequestHandler,
  isAuthorized,
  rateLimitFromEnv,
  safeEqual,
} from '../src/http-auth.js'

describe('safeEqual', () => {
  it('confronta valori uguali e diversi', () => {
    expect(safeEqual('segreto', 'segreto')).toBe(true)
    expect(safeEqual('segreto', 'segretX')).toBe(false)
  })

  it('non lancia con lunghezze diverse o stringhe vuote', () => {
    expect(safeEqual('corto', 'molto-piu-lungo-del-previsto')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('isAuthorized', () => {
  const req = (authorization?: string) =>
    ({ headers: { authorization } }) as unknown as http.IncomingMessage

  it('accetta solo Bearer col token giusto', () => {
    expect(isAuthorized(req('Bearer tok'), 'tok')).toBe(true)
    expect(isAuthorized(req('Bearer sbagliato-e-lungo'), 'tok')).toBe(false)
    expect(isAuthorized(req('Basic tok'), 'tok')).toBe(false)
    expect(isAuthorized(req('Bearer'), 'tok')).toBe(false)
    expect(isAuthorized(req(undefined), 'tok')).toBe(false)
  })
})

describe('FailureRateLimiter', () => {
  it('blocca dopo N fallimenti e si sblocca a finestra scaduta', () => {
    let now = 1_000_000
    const limiter = new FailureRateLimiter({ maxFailures: 3, windowMs: 60_000, now: () => now })
    for (let i = 0; i < 2; i++) limiter.recordFailure('1.1.1.1')
    expect(limiter.retryAfterSeconds('1.1.1.1')).toBe(0)
    limiter.recordFailure('1.1.1.1')
    expect(limiter.retryAfterSeconds('1.1.1.1')).toBe(60)
    now += 30_000
    expect(limiter.retryAfterSeconds('1.1.1.1')).toBe(30)
    now += 30_000
    expect(limiter.retryAfterSeconds('1.1.1.1')).toBe(0)
  })

  it('conta separatamente per IP', () => {
    const limiter = new FailureRateLimiter({ maxFailures: 1, windowMs: 1000 })
    limiter.recordFailure('1.1.1.1')
    expect(limiter.retryAfterSeconds('1.1.1.1')).toBeGreaterThan(0)
    expect(limiter.retryAfterSeconds('2.2.2.2')).toBe(0)
  })
})

describe('rateLimitFromEnv', () => {
  it('usa i default e ignora valori non validi', () => {
    expect(rateLimitFromEnv({})).toEqual({ maxFailures: 10, windowMs: 60_000 })
    expect(
      rateLimitFromEnv({
        MCP_HTTP_RATE_LIMIT_MAX: '5',
        MCP_HTTP_RATE_LIMIT_WINDOW_SECONDS: '30',
      }),
    ).toEqual({ maxFailures: 5, windowMs: 30_000 })
    expect(rateLimitFromEnv({ MCP_HTTP_RATE_LIMIT_MAX: 'abc' }).maxFailures).toBe(10)
    expect(rateLimitFromEnv({ MCP_HTTP_RATE_LIMIT_MAX: '0' }).maxFailures).toBe(10)
  })
})

describe('server HTTP (end-to-end, porta effimera)', () => {
  let server: http.Server | undefined
  let mcpCalls = 0

  async function start(maxFailures = 3): Promise<string> {
    mcpCalls = 0
    const handler = createRequestHandler({
      token: 'tok',
      httpPath: '/mcp',
      limiter: new FailureRateLimiter({ maxFailures, windowMs: 60_000 }),
      mcp: (_url, _req, res) => {
        mcpCalls++
        res.writeHead(200).end('mcp')
        return Promise.resolve()
      },
    })
    server = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  it('/healthz risponde 200 senza token e senza passare dall MCP', async () => {
    const base = await start()
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(mcpCalls).toBe(0)
  })

  it('/healthz non viene limitato dal rate limit', async () => {
    const base = await start(1)
    await fetch(`${base}/mcp`)
    expect((await fetch(`${base}/mcp`)).status).toBe(429)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('/mcp: 401 senza token, 200 col token, 404 altrove', async () => {
    const base = await start()
    expect((await fetch(`${base}/mcp`)).status).toBe(401)
    expect(mcpCalls).toBe(0)
    const ok = await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer tok' } })
    expect(ok.status).toBe(200)
    expect(mcpCalls).toBe(1)
    expect((await fetch(`${base}/altro`)).status).toBe(404)
  })

  it('dopo N token errati risponde 429 con Retry-After, anche col token giusto', async () => {
    const base = await start(2)
    const bad = { headers: { Authorization: 'Bearer no' } }
    expect((await fetch(`${base}/mcp`, bad)).status).toBe(401)
    expect((await fetch(`${base}/mcp`, bad)).status).toBe(401)
    const blocked = await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer tok' } })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(mcpCalls).toBe(0)
  })
})
