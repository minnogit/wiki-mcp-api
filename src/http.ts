import 'dotenv/config'
import http from 'node:http'
import { remoteServer } from './server.js'

const PORT = Number(process.env.MCP_HTTP_PORT ?? 3000)
const HTTP_PATH = '/mcp'
const TOKEN = process.env.MCP_HTTP_TOKEN

if (!TOKEN) {
  console.error('MCP_HTTP_TOKEN non impostato: obbligatorio per esporre il server in HTTP. Interrompo.')
  process.exit(1)
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? ''
  const [scheme, value] = header.split(' ')
  return scheme === 'Bearer' && value === TOKEN
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname !== HTTP_PATH) {
    res.writeHead(404).end('Not found')
    return
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  try {
    await remoteServer.startHTTP({ url, httpPath: HTTP_PATH, req, res })
  } catch (error) {
    console.error('Errore gestione richiesta MCP HTTP:', error)
    if (!res.headersSent) {
      res.writeHead(500).end('Internal server error')
    }
  }
})

httpServer.listen(PORT, () => {
  console.log(`MCP wiki server (read-only) in ascolto su http://localhost:${PORT}${HTTP_PATH}`)
})
