import * as fs from 'node:fs'
import { ConfigError } from './config.js'

// Logging strutturato senza dipendenze. Una riga = un evento: `ts` (ISO UTC), `level`, `event`
// e i campi extra. Lo stesso modulo serve ai log applicativi e, tramite `Auditor` (src/audit.ts),
// all'audit; qui c'è anche la sanificazione centralizzata, l'unico punto in cui si decide che
// cosa può finire in una riga di log.
//
// Regola per stdio: stdout è il canale del protocollo MCP, quindi il logger di stdio scrive solo
// su stderr (`createLogger({ stream: 'stderr' })`). Nessun altro modulo deve usare console.log.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
export type LogFormat = 'json' | 'text'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  /**
   * Scrive una riga a prescindere dal livello (`silent` incluso): per gli eventi di audit e di
   * accesso, che non devono sparire perché qualcuno ha alzato LOG_LEVEL.
   */
  always(event: string, fields?: LogFields): void
  readonly level: LogLevel
  readonly format: LogFormat
}

// --- sanificazione ----------------------------------------------------------------------------

const MAX_STRING = 500
const MAX_DEPTH = 4
const MAX_ITEMS = 20

// Chiavi i cui valori non devono mai comparire, a qualunque profondità. `contentLength` e simili
// passano: il pattern colpisce `content`/`body` esatti, non i prefissi.
const SECRET_KEY =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|hash)|^(content|body)$/i

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const HASH_LIKE = /\bsha256:[0-9a-f]{16,}/gi

/** Tronca a `max` caratteri (punti di codice, senza spezzare coppie surrogate). */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const chars = [...value]
  return chars.length <= max ? value : chars.slice(0, max).join('') + '…'
}

/** Ripulisce una stringa da segreti riconoscibili e la limita in lunghezza. */
export function sanitizeString(value: string, max = MAX_STRING): string {
  return truncate(value.replace(BEARER, '$1 [redatto]').replace(HASH_LIKE, '[hash redatto]'), max)
}

/**
 * Messaggio d'errore breve e innocuo: una riga, senza stack, senza percorsi assoluti del
 * filesystem (finiscono in `<percorso>`), senza segreti riconoscibili.
 */
export function shortError(error: unknown, max = 200): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'errore'
  const oneLine = (raw.split('\n')[0] ?? '').trim()
  const noPaths = oneLine.replace(
    /(^|[\s'"(=:])((?:[A-Za-z]:)?(?:[\\/][^\s'"):,;]+)+)/g,
    '$1<percorso>',
  )
  return sanitizeString(noPaths, max)
}

/**
 * Rende un valore qualunque sicuro per il log: stringhe ripulite e troncate, chiavi sensibili
 * redatte, `Error` ridotti al solo messaggio breve (mai lo stack), profondità e ampiezza limitate.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return { name: value.name, message: shortError(value) }
  if (typeof value !== 'object') return String(typeof value)
  if (depth >= MAX_DEPTH) return '[troncato]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => sanitize(v, depth + 1))
    return value.length > MAX_ITEMS ? [...items, `[+${value.length - MAX_ITEMS}]`] : items
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    out[k] = SECRET_KEY.test(k) ? '[redatto]' : sanitize(v, depth + 1)
  }
  return out
}

// --- formato ----------------------------------------------------------------------------------

const RESERVED = new Set(['ts', 'level', 'event'])

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * Una riga di log (senza newline finale). In JSON ogni controllo (newline compresi) è escapato da
 * JSON.stringify; nel formato text ogni valore che non sia un token semplice è tra virgolette
 * JSON, quindi un newline nel valore non può mai aprire una riga nuova.
 */
export function formatLine(
  format: LogFormat,
  level: string,
  event: string,
  fields: LogFields,
  now: Date = new Date(),
): string {
  const ts = now.toISOString()
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED.has(k) || v === undefined) continue
    clean[safeKey(k)] = SECRET_KEY.test(k) ? '[redatto]' : sanitize(v)
  }
  if (format === 'json') return JSON.stringify({ ts, level, event: safeKey(event), ...clean })
  const parts = [ts, level.toUpperCase().padEnd(5), safeKey(event)]
  for (const [k, v] of Object.entries(clean)) {
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${k}=${/^[\w.:/@+-]+$/.test(text) ? text : JSON.stringify(text)}`)
  }
  return parts.join(' ')
}

// --- logger -----------------------------------------------------------------------------------

export interface LoggerOptions {
  level?: LogLevel
  format?: LogFormat
  /** `stdout` per l'HTTP, `stderr` per stdio. Ignorato se c'è `sink`. */
  stream?: 'stdout' | 'stderr'
  /** Destinazione delle righe già formattate (per i test o per un file). */
  sink?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const format = options.format ?? 'json'
  const stream = options.stream === 'stdout' ? process.stdout : process.stderr
  const sink = options.sink ?? ((line: string) => void stream.write(line + '\n'))
  const emit = (lvl: string, event: string, fields?: LogFields) =>
    sink(formatLine(format, lvl, event, fields ?? {}))
  const at = (lvl: Exclude<LogLevel, 'silent'>) => (event: string, fields?: LogFields) => {
    if (RANK[lvl] >= RANK[level]) emit(lvl, event, fields)
  }
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    always: (event, fields) => emit('info', event, fields),
    level,
    format,
  }
}

/** Livello valido da una variabile d'ambiente, altrimenti `undefined`. */
export function parseLevel(raw: string | undefined): LogLevel | undefined {
  const v = raw?.trim().toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(v ?? '') ? (v as LogLevel) : undefined
}

export function parseFormat(raw: string | undefined): LogFormat | undefined {
  const v = raw?.trim().toLowerCase()
  return v === 'json' || v === 'text' ? v : undefined
}

/**
 * Logger dall'ambiente: `LOG_LEVEL` (default `info`) e `LOG_FORMAT` (default `json` in HTTP,
 * `text` in stdio, dove lo legge una persona). Valori non validi tornano al default.
 */
export function loggerFromEnv(
  env: NodeJS.ProcessEnv,
  transport: 'http' | 'stdio',
  sink?: (line: string) => void,
): Logger {
  return createLogger({
    level: parseLevel(env.LOG_LEVEL) ?? 'info',
    format: parseFormat(env.LOG_FORMAT) ?? (transport === 'http' ? 'json' : 'text'),
    stream: transport === 'http' ? 'stdout' : 'stderr',
    sink,
  })
}

// Logger di processo: gli entrypoint lo configurano con `setLogger`. Prima di allora (e nei
// test) scrive su stderr, mai su stdout, quindi è sicuro anche per stdio.
let current: Logger = loggerFromEnv(process.env, 'stdio')

export function log(): Logger {
  return current
}

export function setLogger(logger: Logger): void {
  current = logger
}

// --- destinazione su file ---------------------------------------------------------------------

/**
 * File di audit in append. Si apre in modo sincrono nel costruttore (0600 alla creazione), così
 * un percorso non scrivibile fallisce all'avvio con un errore chiaro e non alla prima riga. Le
 * scritture passano da un unico `WriteStream`, che le accoda in ordine senza bloccare l'event
 * loop e senza perdere righe con richieste concorrenti. `reopen()` (SIGHUP, dopo la rotazione
 * di logrotate) apre di nuovo il percorso: il vecchio stream finisce di scrivere ciò che ha in
 * coda sul vecchio file e poi lo chiude.
 */
export class AppendFile {
  private stream: fs.WriteStream
  private failed = false

  constructor(
    private readonly file: string,
    private readonly onError: (message: string) => void = () => {},
  ) {
    this.stream = this.open()
  }

  private open(): fs.WriteStream {
    let fd: number
    try {
      fd = fs.openSync(this.file, 'a', 0o600)
    } catch (e) {
      throw new ConfigError(
        `AUDIT_LOG_FILE: non riesco a scrivere in ${this.file}: ${(e as Error).message}`,
      )
    }
    const stream = fs.createWriteStream(this.file, { fd, flags: 'a', autoClose: true })
    stream.on('error', (e) => {
      this.failed = true
      this.onError(shortError(e))
    })
    return stream
  }

  /** `false` se il file ha dato errore a runtime: il chiamante ripiega sullo stream del logger. */
  write(line: string): boolean {
    if (this.failed) return false
    this.stream.write(line + '\n')
    return true
  }

  /** Riapre il file; in caso di errore tiene il vecchio e lo segnala, senza lanciare. */
  reopen(): boolean {
    let next: fs.WriteStream
    try {
      next = this.open()
    } catch (e) {
      this.onError(shortError(e))
      return false
    }
    const old = this.stream
    this.stream = next
    this.failed = false
    old.end()
    return true
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stream.destroyed) return resolve()
      this.stream.end(() => resolve())
    })
  }
}
