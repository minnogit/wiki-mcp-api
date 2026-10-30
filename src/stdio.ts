import 'dotenv/config'
import { ConfigError, loadWikis, selectWiki } from './config.js'
import { log, setLogger, loggerFromEnv, shortError } from './log.js'
import { createTelemetryFromEnv, setTelemetry } from './telemetry.js'
import { buildServer } from './server.js'
import { createWikiService } from './wiki/service.js'

// stdout è il protocollo MCP: il logger di stdio scrive solo su stderr, e l'audit è spento
// a meno che AUDIT_LOG_FILE lo chieda (vedi `createTelemetryFromEnv`).
setLogger(loggerFromEnv(process.env, 'stdio'))

// Una wiki per processo. Con WIKI_CONFIG che ne elenca più d'una, WIKI_NAME dice quale servire.
let ctx
try {
  ctx = selectWiki(loadWikis(), process.env.WIKI_NAME)
  setTelemetry(createTelemetryFromEnv(process.env, 'stdio'))
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  log().error('startup-error', { msg: error.message })
  process.exit(1)
}

buildServer(createWikiService(ctx))
  .startStdio()
  .catch((error: unknown) => {
    log().error('startup-error', { msg: `Errore avvio MCP server: ${shortError(error)}` })
    process.exit(1)
  })
