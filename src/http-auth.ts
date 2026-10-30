import { createHash, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

export const HEALTH_PATH = '/healthz'

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Confronto a tempo costante. Si confrontano gli hash sha256 dei due valori:
 * hanno sempre la stessa lunghezza, quindi timingSafeEqual non lancia e non
 * rivela la lunghezza del token atteso.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

export function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const [scheme, value] = header.split(' ')
  return scheme === 'Bearer' && value !== undefined && safeEqual(value, token)
}

export interface RateLimitOptions {
  /** Fallimenti consentiti nella finestra prima di rispondere 429. */
  maxFailures: number
  /** Ampiezza della finestra, in millisecondi. */
  windowMs: number
  /** Orologio iniettabile per i test. */
  now?: () => number
}

/**
 * Rate limit in memoria per IP, sulle sole richieste con token errato o
 * mancante. Finestra fissa: il primo fallimento apre la finestra, allo scadere
 * il contatore riparte.
 */
export class FailureRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>()
  private readonly now: () => number

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now
  }

  /** Secondi da attendere se l'IP è bloccato, altrimenti 0. */
  retryAfterSeconds(ip: string): number {
    const entry = this.entries.get(ip)
    if (!entry) return 0
    const now = this.now()
    if (now >= entry.resetAt) {
      this.entries.delete(ip)
      return 0
    }
    if (entry.count < this.options.maxFailures) return 0
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  }

  recordFailure(ip: string): void {
    const now = this.now()
    this.prune(now)
    const entry = this.entries.get(ip)
    if (!entry || now >= entry.resetAt) {
      this.entries.set(ip, { count: 1, resetAt: now + this.options.windowMs })
    } else {
      entry.count += 1
    }
  }

  // Evita che la mappa cresca senza limite con IP che non tornano più.
  private prune(now: number): void {
    if (this.entries.size < 1000) return
    for (const [ip, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(ip)
    }
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitOptions {
  return {
    maxFailures: positiveInt(env.MCP_HTTP_RATE_LIMIT_MAX, 10),
    windowMs: positiveInt(env.MCP_HTTP_RATE_LIMIT_WINDOW_SECONDS, 60) * 1000,
  }
}

export interface RequestHandlerOptions {
  token: string
  httpPath: string
  limiter: FailureRateLimiter
  /** Gestore delle richieste MCP autenticate. */
  mcp: (url: URL, req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
}

export function createRequestHandler(options: RequestHandlerOptions) {
  const { token, httpPath, limiter, mcp } = options

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)

    // Prima del token e fuori dal server MCP: nessun contenuto, nessuna versione.
    if (url.pathname === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (url.pathname !== httpPath) {
      res.writeHead(404).end('Not found')
      return
    }

    const ip = req.socket.remoteAddress ?? 'unknown'

    const retryAfter = limiter.retryAfterSeconds(ip)
    if (retryAfter > 0) {
      res
        .writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) })
        .end(JSON.stringify({ error: 'too_many_requests' }))
      return
    }

    if (!isAuthorized(req, token)) {
      limiter.recordFailure(ip)
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    try {
      await mcp(url, req, res)
    } catch (error) {
      console.error('Errore gestione richiesta MCP HTTP:', error)
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error')
      }
    }
  }
}
