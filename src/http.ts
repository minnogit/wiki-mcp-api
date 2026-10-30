import 'dotenv/config'
import http from 'node:http'
import { FailureRateLimiter, createRequestHandler, rateLimitFromEnv } from './http-auth.js'
import { rawOverHttp, remoteServer } from './server.js'

const PORT = Number(process.env.MCP_HTTP_PORT ?? 3000)
// Di default solo loopback: per esporre il server serve sceglierlo (es. 0.0.0.0
// in un container, o un reverse proxy locale davanti).
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1'
const HTTP_PATH = '/mcp'
const TOKEN = process.env.MCP_HTTP_TOKEN

if (!TOKEN) {
  console.error(
    'MCP_HTTP_TOKEN non impostato: obbligatorio per esporre il server in HTTP. Interrompo.',
  )
  process.exit(1)
}

const handleRequest = createRequestHandler({
  token: TOKEN,
  httpPath: HTTP_PATH,
  limiter: new FailureRateLimiter(rateLimitFromEnv()),
  mcp: (url, req, res) => remoteServer.startHTTP({ url, httpPath: HTTP_PATH, req, res }),
})

const httpServer = http.createServer((req, res) => void handleRequest(req, res))

httpServer.listen(PORT, HOST, () => {
  console.log(`MCP wiki server (read-only) in ascolto su http://${HOST}:${PORT}${HTTP_PATH}`)
  console.log(
    rawOverHttp
      ? 'ATTENZIONE: MCP_HTTP_EXPOSE_RAW=true, i tool sulle sorgenti (raw/) sono esposti a chi ha il token.'
      : 'Sorgenti (raw/) non esposte: solo i tool sulle pagine. MCP_HTTP_EXPOSE_RAW=true per abilitarle.',
  )
})
