import 'dotenv/config'
import { server } from './server.js'

server.startStdio().catch((error) => {
  console.error('Errore avvio MCP server:', error)
  process.exit(1)
})
