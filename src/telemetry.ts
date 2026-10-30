import { DISABLED_AUDITOR, createAuditor, type Auditor } from './audit.js'
import { AppendFile, loggerFromEnv, log, setLogger, type Logger } from './log.js'
import { Metrics } from './metrics.js'

/** Tutto ciò che serve a osservare il server: logger applicativo, audit e metriche. */
export interface Telemetry {
  logger: Logger
  auditor: Auditor
  metrics: Metrics
  /** Caratteri massimi della query di wikiSearch nell'audit (AUDIT_QUERY_MAX_CHARS). */
  queryMaxChars: number
}

export const DEFAULT_QUERY_MAX_CHARS = 100

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Telemetria dall'ambiente. In HTTP l'audit è sempre attivo (stesso stream del logger, o file con
 * `AUDIT_LOG_FILE`); in stdio è spento a meno che `AUDIT_LOG_FILE` lo chieda esplicitamente, perché
 * lì stdout è il protocollo MCP e stderr è già il canale degli errori. Un file non scrivibile
 * lancia `ConfigError`: l'avvio fallisce, non la prima richiesta.
 */
export function createTelemetryFromEnv(
  env: NodeJS.ProcessEnv,
  transport: 'http' | 'stdio',
  sink?: (line: string) => void,
): Telemetry {
  const logger = loggerFromEnv(env, transport, sink)
  const file = env.AUDIT_LOG_FILE?.trim() || undefined
  let auditor: Auditor
  if (file) {
    const target = new AppendFile(file, (message) =>
      logger.error('audit-write-failed', {
        msg: `scrittura dell'audit su file fallita: ${message}`,
      }),
    )
    auditor = createAuditor(logger, target)
  } else {
    auditor = transport === 'http' ? createAuditor(logger) : DISABLED_AUDITOR
  }
  return {
    logger,
    auditor,
    metrics: new Metrics(),
    queryMaxChars: positiveInt(env.AUDIT_QUERY_MAX_CHARS, DEFAULT_QUERY_MAX_CHARS),
  }
}

// Telemetria di processo. Gli entrypoint la installano con `setTelemetry`; chi costruisce un
// server senza (i test) ottiene un auditor spento e metriche proprie: nessun effetto collaterale.
let current: Telemetry | undefined

export function setTelemetry(telemetry: Telemetry): void {
  current = telemetry
  setLogger(telemetry.logger)
}

export function telemetry(): Telemetry {
  current ??= {
    logger: log(),
    auditor: DISABLED_AUDITOR,
    metrics: new Metrics(),
    queryMaxChars: DEFAULT_QUERY_MAX_CHARS,
  }
  return current
}
