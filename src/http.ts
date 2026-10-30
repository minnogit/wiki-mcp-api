import 'dotenv/config'
import http from 'node:http'
import type { MCPServer } from '@mastra/mcp'
import { createAuthFromEnv, runWithPrincipal } from './auth.js'
import { ConfigError, loadWikis } from './config.js'
import { FailureRateLimiter, createRequestHandler, rateLimitFromEnv } from './http-auth.js'
import { buildRemoteServer, rawOverHttp } from './server.js'
import { createWikiService } from './wiki/service.js'

const PORT = Number(process.env.MCP_HTTP_PORT ?? 3000)
// Di default solo loopback: per esporre il server serve sceglierlo (es. 0.0.0.0
// in un container, o un reverse proxy locale davanti).
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1'

let wikis
try {
  wikis = loadWikis()
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(`${error.message}\nInterrompo.`)
  process.exit(1)
}

let setup
try {
  setup = createAuthFromEnv(
    process.env,
    wikis.map((w) => w.name),
  )
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(`${error.message}\nInterrompo.`)
  process.exit(1)
}
for (const w of setup.warnings) console.warn(`AVVISO: ${w}`)

// Un MCPServer per wiki, creati una volta all'avvio (non per richiesta): ognuno ha il proprio
// service, quindi la propria cache, e tiene le proprie sessioni MCP.
const exposeRaw = rawOverHttp()
const servers = new Map<string, MCPServer>(
  wikis.map((ctx) => [ctx.name, buildRemoteServer(createWikiService(ctx), { exposeRaw })]),
)

const handleRequest = createRequestHandler({
  auth: setup.authenticator,
  limiter: new FailureRateLimiter(rateLimitFromEnv()),
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

httpServer.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`
  console.log(`MCP wiki server (read-only) in ascolto su ${base}`)
  for (const w of wikis) {
    console.log(`  /mcp/${w.name}${w.rawDir ? '' : ' (senza sorgenti raw)'}`)
  }
  if (wikis.length === 1) {
    console.log(`  /mcp (alias di /mcp/${wikis[0].name}, valido solo con una wiki configurata)`)
  }
  console.log(
    exposeRaw
      ? 'ATTENZIONE: MCP_HTTP_EXPOSE_RAW=true, i tool sulle sorgenti (raw/) sono esposti a chi ha il token, per ogni wiki con rawPath.'
      : 'Sorgenti (raw/) non esposte: solo i tool sulle pagine. MCP_HTTP_EXPOSE_RAW=true per abilitarle.',
  )
  for (const line of setup.summary) console.log(`Autenticazione: ${line}`)
})
