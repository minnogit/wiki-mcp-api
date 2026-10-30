import 'dotenv/config'
import { ConfigError, loadWikis, selectWiki } from './config.js'
import { buildServer } from './server.js'
import { createWikiService } from './wiki/service.js'

// Una wiki per processo. Con WIKI_CONFIG che ne elenca più d'una, WIKI_NAME dice quale servire.
let ctx
try {
  ctx = selectWiki(loadWikis(), process.env.WIKI_NAME)
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}

buildServer(createWikiService(ctx))
  .startStdio()
  .catch((error) => {
    console.error('Errore avvio MCP server:', error)
    process.exit(1)
  })
