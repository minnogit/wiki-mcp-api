import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'
import {
  canAccessWiki,
  createAuthenticator,
  type AuthCheck,
  type Authenticator,
  type Principal,
} from './auth.js'
import { runWithRequestId } from './audit.js'
import { shortError, truncate } from './log.js'
import { METRIC, type AuthReason } from './metrics.js'
import { telemetry as processTelemetry, type Telemetry } from './telemetry.js'

export const HEALTH_PATH = '/healthz'
export const METRICS_PATH = '/metrics'
export const MCP_PATH = '/mcp'

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

/** Il token dell'header `Authorization: Bearer <token>`, se c'è. */
export function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? ''
  const [scheme, value] = header.split(' ')
  return scheme === 'Bearer' && value !== undefined ? value : undefined
}

export function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const value = bearerToken(req)
  return value !== undefined && safeEqual(value, token)
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
  /** Verifica dei token e identità (vedi `createAuthFromEnv`). */
  auth?: Authenticator
  /**
   * Scorciatoia per il solo token unico: equivale a un autenticatore con la sola credenziale
   * legacy (principal `legacy`, tutte le wiki). Se c'è `auth`, `token` è ignorato.
   */
  token?: string
  limiter: FailureRateLimiter
  /** Logger, audit e metriche. Default: la telemetria di processo (`setTelemetry`). */
  telemetry?: Telemetry
  /**
   * Token (Bearer) dedicato a `GET /metrics`, distinto da quelli MCP. Senza, l'endpoint non esiste:
   * 404 come qualunque altro percorso.
   */
  metricsToken?: string
  /** Nomi delle wiki servite (già validati all'avvio). */
  wikis: readonly string[]
  /**
   * Gestore delle richieste MCP autenticate, già risolte su una wiki esistente e abilitata per
   * il principal. Chi lo implementa deve eseguire il server MCP dentro `runWithPrincipal`.
   */
  mcp: (
    wiki: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    principal: Principal,
  ) => Promise<void>
}

// `/mcp/<name>`: un solo segmento, senza decodifica né slash. Altri percorsi sotto /mcp/ non
// sono endpoint di nessuna wiki e restano 404 anche prima dell'autenticazione, come un path qualunque.
const WIKI_PATH_RE = /^\/mcp\/([^/]+)$/

type Route = { kind: 'wiki'; name: string } | { kind: 'alias' } | null

function routeOf(pathname: string): Route {
  if (pathname === MCP_PATH) return { kind: 'alias' }
  const m = WIKI_PATH_RE.exec(pathname)
  return m ? { kind: 'wiki', name: m[1] } : null
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404).end('Not found')
}

export function createRequestHandler(options: RequestHandlerOptions) {
  const { limiter, wikis, mcp, metricsToken } = options
  const auth =
    options.auth ??
    (options.token
      ? createAuthenticator({ legacyToken: options.token })
      : (() => {
          throw new Error('createRequestHandler: serve `auth` o `token`')
        })())
  const check = (token: string): AuthCheck =>
    auth.check?.(token) ??
    (() => {
      const principal = auth.authenticate(token)
      return principal ? { principal } : { reason: 'invalid-token' as const }
    })()

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const tel = options.telemetry ?? processTelemetry()
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)

    // Prima del token e fuori dal server MCP: nessun contenuto, nessuna versione. Niente evento,
    // niente metrica: è rumore (healthcheck ogni pochi secondi).
    if (url.pathname === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: 'ok' }))
      return
    }

    const requestId = randomUUID()
    const ip = req.socket.remoteAddress ?? 'unknown'
    res.once('finish', () =>
      tel.metrics.inc(
        METRIC.httpRequests,
        { status: String(res.statusCode) },
        'Richieste HTTP per codice di stato (esclusa /healthz)',
      ),
    )

    // Un fallimento di accesso: evento `auth` (mai il token presentato né i suoi hash) e metrica.
    // `reason` è interno: il client vede solo 401/429/404 identici per tutti i motivi.
    const denyAccess = (
      reason: AuthReason,
      status: number,
      extra: Record<string, unknown> = {},
    ): void => {
      tel.metrics.inc(
        METRIC.authFailures,
        { reason },
        'Accessi HTTP rifiutati, per motivo (401, 429, 404 su wiki non accessibile)',
      )
      tel.auditor.record('auth', { requestId, ip, reason, status, ...extra })
    }

    const rateLimited = (extra: Record<string, unknown>): boolean => {
      const retryAfter = limiter.retryAfterSeconds(ip)
      if (retryAfter <= 0) return false
      denyAccess('rate-limited', 429, { ...extra, retryAfterSeconds: retryAfter })
      res
        .writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) })
        .end(JSON.stringify({ error: 'too_many_requests' }))
      return true
    }

    const unauthorized = (reason: AuthReason, extra: Record<string, unknown>): void => {
      limiter.recordFailure(ip)
      denyAccess(reason, 401, extra)
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'unauthorized' }))
    }

    // Metriche: solo con un token dedicato configurato; stesso rate limit sui tentativi falliti.
    if (url.pathname === METRICS_PATH && metricsToken !== undefined && req.method === 'GET') {
      const extra = { endpoint: 'metrics' }
      if (rateLimited(extra)) return
      const presented = bearerToken(req)
      if (presented === undefined) return unauthorized('missing-token', extra)
      if (!safeEqual(presented, metricsToken)) return unauthorized('invalid-token', extra)
      res
        .writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
        .end(await tel.metrics.renderText())
      return
    }

    const route = routeOf(url.pathname)
    if (!route) {
      notFound(res)
      return
    }

    const extra = { endpoint: 'mcp' }
    if (rateLimited(extra)) return

    // Token sconosciuto, revocato o scaduto: stessa 401 e stesso conteggio nel rate limit.
    const presented = bearerToken(req)
    if (presented === undefined) return unauthorized('missing-token', extra)
    const checked = check(presented)
    const principal = checked.principal
    if (!principal) return unauthorized(checked.reason, extra)

    // Solo da qui, a token valido, si decide a quale wiki va la richiesta: chi non ha il token
    // non deve poter distinguere un nome esistente da uno inesistente (stessa 401 per tutti), né
    // scoprire se il server è configurato con una o più wiki. `/mcp` senza nome è un alias
    // valido solo con una wiki sola; con più wiki l'endpoint va scelto, e il messaggio non li elenca.
    // Una wiki non abilitata per questo principal è trattata come inesistente: stessa 404, stesso
    // corpo, così un token valido non può sondare l'esistenza di wiki che non gli sono assegnate.
    // Nell'audit i due casi restano distinti (`wiki-not-allowed` / `wiki-unknown`), solo lì.
    let wiki: string | undefined
    if (route.kind === 'alias') {
      if (wikis.length === 1) wiki = wikis[0]
    } else if (wikis.includes(route.name)) {
      wiki = route.name
    }
    if (wiki === undefined || !canAccessWiki(principal, wiki)) {
      denyAccess(wiki === undefined ? 'wiki-unknown' : 'wiki-not-allowed', 404, {
        ...extra,
        principal: { id: principal.id, user: principal.user },
        requestedWiki: route.kind === 'wiki' ? truncate(route.name, 64) : '(alias)',
      })
      notFound(res)
      return
    }

    try {
      await runWithRequestId(requestId, () => mcp(wiki, url, req, res, principal))
    } catch (error) {
      tel.logger.error('request-error', {
        requestId,
        msg: 'Errore gestione richiesta MCP HTTP',
        error: shortError(error),
      })
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error')
      }
    }
  }
}
