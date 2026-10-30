import 'dotenv/config'
import http from 'node:http'
import type { MCPServer } from '@mastra/mcp'
import { loggerFromEnv, shortError } from './log.js'
import { createAuthFromEnv, runWithPrincipal } from './auth.js'
import { ConfigError, loadWikis } from './config.js'
import { FailureRateLimiter, createRequestHandler, rateLimitFromEnv } from './http-auth.js'
import { buildRemoteServer, rawOverHttp, registerWikiGauge } from './server.js'
import { createTelemetryFromEnv, setTelemetry, type Telemetry } from './telemetry.js'
import { safeEqual } from './http-auth.js'
import { createWikiService } from './wiki/service.js'

const PORT = Number(process.env.MCP_HTTP_PORT ?? 3000)
// Di default solo loopback: per esporre il server serve sceglierlo (es. 0.0.0.0
// in un container, o un reverse proxy locale davanti).
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1'

// Errori di configurazione all'avvio: una riga di log (error) e uscita con codice 1. Il logger di
// emergenza nasce prima della telemetria, che può fallire essa stessa (file di audit non scrivibile).
const bootLogger = loggerFromEnv(process.env, 'http')
function fatal(error: unknown): never {
  if (!(error instanceof ConfigError)) throw error
  bootLogger.error('startup-error', { msg: `${error.message}\nInterrompo.` })
  process.exit(1)
}

let tel: Telemetry
try {
  tel = createTelemetryFromEnv(process.env, 'http')
} catch (error) {
  fatal(error)
}
setTelemetry(tel)
const log = tel.logger

let wikis
try {
  wikis = loadWikis()
} catch (error) {
  fatal(error)
}

// Token delle metriche: dedicato e diverso da quello MCP, altrimenti chi legge le metriche
// avrebbe anche l'accesso ai tool.
const metricsToken = process.env.MCP_METRICS_TOKEN || undefined
try {
  if (
    metricsToken &&
    process.env.MCP_HTTP_TOKEN &&
    safeEqual(metricsToken, process.env.MCP_HTTP_TOKEN)
  ) {
    throw new ConfigError('MCP_METRICS_TOKEN deve essere diverso da MCP_HTTP_TOKEN.')
  }
} catch (error) {
  fatal(error)
}

let setup
try {
  setup = createAuthFromEnv(
    process.env,
    wikis.map((w) => w.name),
    { logger: (msg) => log.error('token-file-error', { msg }) },
  )
} catch (error) {
  fatal(error)
}
for (const w of setup.warnings) log.warn('config-warning', { msg: `AVVISO: ${w}` })

// Un MCPServer per wiki, creati una volta all'avvio (non per richiesta): ognuno ha il proprio
// service, quindi la propria cache, e tiene le proprie sessioni MCP.
const exposeRaw = rawOverHttp()
const servers = new Map<string, MCPServer>(
  wikis.map((ctx) => {
    const svc = createWikiService(ctx)
    registerWikiGauge(svc, tel)
    return [ctx.name, buildRemoteServer(svc, { exposeRaw, telemetry: tel })]
  }),
)

const handleRequest = createRequestHandler({
  auth: setup.authenticator,
  limiter: new FailureRateLimiter(rateLimitFromEnv()),
  telemetry: tel,
  metricsToken,
  wikis: wikis.map((w) => w.name),
  mcp: (wiki, url, req, res, principal) =>
    // L'identità viaggia nel contesto async (vedi `currentPrincipal` in src/auth.ts), non come
    // parametro dei tool. httpPath è il percorso effettivo della richiesta (/mcp o /mcp/<name>):
    // il server MCP lo confronta con l'URL.
    runWithPrincipal(principal, () =>
      servers.get(wiki)!.startHTTP({ url, httpPath: url.pathname, req, res }),
    ),
})

const httpServer = http.createServer((req, res) => void handleRequest(req, res))

// SIGHUP: riapre il file di audit dopo la rotazione (logrotate). Il gestore c'è sempre, anche
// senza file: il default di SIGHUP è terminare il processo, e `systemctl reload` non deve farlo.
process.on('SIGHUP', () => {
  const reopened = tel.auditor.reopen()
  log.info('reload', { msg: 'SIGHUP ricevuto', auditFileReopened: reopened })
})

// Arresto ordinato: lo stream del file di audit finisce di scrivere ciò che ha in coda.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info('shutdown', { msg: `${signal} ricevuto, chiudo`, signal })
    httpServer.close()
    tel.auditor
      .close()
      .catch((e: unknown) => log.error('shutdown-error', { error: shortError(e) }))
      .finally(() => process.exit(0))
  })
}

httpServer.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`
  log.info('startup', {
    msg: `MCP wiki server (read-only) in ascolto su ${base}`,
    host: HOST,
    port: PORT,
  })
  for (const w of wikis) {
    log.info('route', {
      msg: `/mcp/${w.name}${w.rawDir ? '' : ' (senza sorgenti raw)'}`,
      wiki: w.name,
      raw: w.rawDir !== undefined,
    })
  }
  if (wikis.length === 1) {
    log.info('route', {
      msg: `/mcp (alias di /mcp/${wikis[0].name}, valido solo con una wiki configurata)`,
    })
  }
  if (exposeRaw) {
    log.warn('config-warning', {
      msg: 'ATTENZIONE: MCP_HTTP_EXPOSE_RAW=true, i tool sulle sorgenti (raw/) sono esposti a chi ha il token, per ogni wiki con rawPath.',
    })
  } else {
    log.info('startup', {
      msg: 'Sorgenti (raw/) non esposte: solo i tool sulle pagine. MCP_HTTP_EXPOSE_RAW=true per abilitarle.',
    })
  }
  for (const line of setup.summary) log.info('startup', { msg: `Autenticazione: ${line}` })
  log.info('startup', {
    msg: metricsToken
      ? 'Metriche: GET /metrics attivo (token dedicato MCP_METRICS_TOKEN)'
      : 'Metriche: GET /metrics non esposto (imposta MCP_METRICS_TOKEN per attivarlo)',
    metrics: metricsToken !== undefined,
    auditFile: process.env.AUDIT_LOG_FILE?.trim() || undefined,
  })
})
