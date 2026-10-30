import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { currentPrincipal } from './auth.js'
import { sanitizeString, shortError, formatLine, type AppendFile, type Logger } from './log.js'
import { METRIC, type Metrics, type Outcome } from './metrics.js'

// Audit strutturato: un evento `audit` per ogni chiamata a un tool, un evento `auth` per ogni
// accesso HTTP rifiutato. Il contratto degli eventi (campi, esiti, sanificazione) vive qui e
// lo riusano le PR successive: i permessi emettono `denied` con `emitDenied`/`DeniedError`, la
// scrittura remota aggiunge eventi con `Auditor.record`.

/** Destinazione degli eventi di audit. */
export interface Auditor {
  /** `false` per un auditor spento (stdio senza AUDIT_LOG_FILE): `record` non fa nulla. */
  readonly enabled: boolean
  record(event: string, fields: Record<string, unknown>): void
  /** Riapre il file di destinazione (SIGHUP dopo la rotazione). No-op senza file. */
  reopen(): boolean
  close(): Promise<void>
}

export const DISABLED_AUDITOR: Auditor = {
  enabled: false,
  record: () => {},
  reopen: () => false,
  close: () => Promise.resolve(),
}

/**
 * Auditor sullo stream del logger (stdout in HTTP) oppure, con `file`, su file in append, sempre
 * in JSON. Gli eventi vanno scritti a prescindere da LOG_LEVEL (`logger.always`). Se il file dà
 * errore a runtime le righe ripiegano sul logger: meglio duplicare che perdere l'audit.
 */
export function createAuditor(logger: Logger, file?: AppendFile): Auditor {
  return {
    enabled: true,
    record(event, fields) {
      if (file && file.write(formatLine('json', 'info', event, fields))) return
      logger.always(event, fields)
    },
    reopen: () => file?.reopen() ?? false,
    close: () => file?.close() ?? Promise.resolve(),
  }
}

/** Identità registrata per le chiamate senza principal (stdio locale). */
export const LOCAL_PRINCIPAL = { id: 'local', user: 'local' } as const

// --- identificativo di richiesta --------------------------------------------------------------

const requestIds = new AsyncLocalStorage<string>()

/** Esegue `fn` con `requestId` come identificativo della richiesta HTTP corrente. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIds.run(requestId, fn)
}

export function currentRequestId(): string | undefined {
  return requestIds.getStore()
}

// --- contesto e registrazione -----------------------------------------------------------------

export interface AuditContext {
  /** Nome della wiki del server su cui è registrato il tool. */
  wiki: string
  auditor: Auditor
  metrics: Metrics
  /** Caratteri massimi della query di wikiSearch nell'audit. */
  queryMaxChars: number
}

export interface ToolCallRecord {
  tool: string
  outcome: Outcome
  durationMs: number
  args?: Record<string, unknown>
  resultSize?: number
  error?: string
  /** Solo per `denied`: perché (es. regola o gruppo mancante). */
  reason?: string
}

/** Registra un evento `audit` e aggiorna le metriche. Unico punto di uscita, per tutti gli esiti. */
export function recordToolCall(ctx: AuditContext, call: ToolCallRecord): void {
  const principal = currentPrincipal()
  ctx.metrics.inc(
    METRIC.toolCalls,
    { wiki: ctx.wiki, tool: call.tool, outcome: call.outcome },
    'Chiamate ai tool per wiki, tool ed esito',
  )
  ctx.metrics.observeDuration(
    METRIC.toolDuration,
    { wiki: ctx.wiki, tool: call.tool },
    call.durationMs / 1000,
  )
  ctx.auditor.record('audit', {
    requestId: currentRequestId() ?? randomUUID(),
    principal: principal ? { id: principal.id, user: principal.user } : LOCAL_PRINCIPAL,
    wiki: ctx.wiki,
    tool: call.tool,
    outcome: call.outcome,
    durationMs: Math.round(call.durationMs * 100) / 100,
    args: call.args ?? {},
    resultSize: call.resultSize,
    error: call.error,
    reason: call.reason,
  })
}

/**
 * Un tool o il service lanciano `DeniedError` per negare una chiamata: `withAudit` la registra
 * come `denied` (non `error`) e la rilancia invariata. In alternativa, chi nega senza lanciare
 * usa `emitDenied`.
 */
export class DeniedError extends Error {
  constructor(
    message: string,
    readonly reason: string = message,
  ) {
    super(message)
    this.name = 'DeniedError'
  }
}

/**
 * Vocabolario CHIUSO dei motivi di `denied` generati dai permessi per pagina. Va nel campo
 * `reason` dell'evento: mai slug, gruppi o altro che un chiamante non debba conoscere.
 * - `visibility`: pagina esistente con `visibilita: riservata`, e il principal non ha il gruppo giusto.
 * - `visibility-invalid`: valore di `visibilita` sconosciuto (refuso), trattato come riservata.
 */
export const DENIED_REASONS = ['visibility', 'visibility-invalid'] as const
export type DeniedReason = (typeof DENIED_REASONS)[number]

// Stato della chiamata a un tool in corso, aperto da `withAudit`. Permette al service di dire
// «questa chiamata è stata negata» senza cambiare la risposta al client (che per una pagina
// nascosta deve restare identica a quella di una pagina inesistente): l'esito `denied` finisce
// solo nell'audit.
interface CallState {
  denied?: DeniedReason
}
const callStates = new AsyncLocalStorage<CallState>()

/**
 * Segna la chiamata corrente come negata (esito `denied` nell'audit) lasciando intatto il
 * risultato restituito al client. No-op fuori da un tool avvolto da `withAudit` (es. il service
 * chiamato direttamente nei test). Vale il primo motivo segnato.
 */
export function markDenied(reason: DeniedReason): void {
  const state = callStates.getStore()
  if (state) state.denied ??= reason
}

/** Emette un evento `denied` per `tool` senza che la chiamata sia stata eseguita. */
export function emitDenied(
  ctx: AuditContext,
  tool: string,
  reason: string,
  input?: Record<string, unknown>,
): void {
  recordToolCall(ctx, {
    tool,
    outcome: 'denied',
    durationMs: 0,
    args: reduceArgs(tool, input, ctx.queryMaxChars),
    reason: sanitizeString(reason, 200),
  })
}

// --- args ridotti -----------------------------------------------------------------------------

type Input = Record<string, unknown>
type Reducer = (input: Input, queryMax: number) => Record<string, unknown>

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' ? sanitizeString(v, max) : undefined
const len = (v: unknown): number | undefined => (typeof v === 'string' ? v.length : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * Per ogni tool, i soli campi registrati nell'audit: identificatori e filtri, mai contenuti.
 * Un tool non elencato qui viene comunque audito, ma con `args` vuoti: aggiungere il tool a
 * questa tabella è una scelta esplicita su cosa è registrabile (vedi CLAUDE.md).
 */
const ARG_REDUCERS: Record<string, Reducer> = {
  wikiSearch: (i, qMax) => ({
    q: str(i.q, qMax),
    qLength: len(i.q),
    tag: str(i.tag, 80),
    tipo: str(i.tipo, 40),
    stato: str(i.stato, 40),
    topK: num(i.topK),
  }),
  wikiReadPage: (i) => ({ slug: str(i.slug) }),
  wikiListPages: (i) => ({ categoria: str(i.categoria, 80) }),
  wikiGraph: () => ({}),
  wikiStatus: () => ({}),
  wikiListRaw: () => ({}),
  wikiReadRaw: (i) => ({ filename: str(i.filename) }),
  wikiRawDiff: (i) => ({ filename: str(i.filename), sinceChecksum: str(i.sinceChecksum, 40) }),
  wikiChecksum: (i) => ({ path: str(i.path) }),
  // Scrittura: solo dove e quanto, MAI il contenuto.
  wikiWritePage: (i) => ({ path: str(i.path), contentLength: len(i.content) }),
  wikiAppendLog: (i) => ({ entryLength: len(i.entry) }),
}

/** Nomi dei tool con una regola di riduzione degli argomenti (per i test di copertura). */
export const AUDITED_TOOLS: readonly string[] = Object.keys(ARG_REDUCERS)

export function reduceArgs(
  tool: string,
  input: unknown,
  queryMaxChars: number,
): Record<string, unknown> {
  const reducer = ARG_REDUCERS[tool]
  if (!reducer || typeof input !== 'object' || input === null) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(reducer(input as Input, queryMaxChars))) {
    if (v !== undefined) out[k] = v
  }
  return out
}

// --- wrapper dei tool -------------------------------------------------------------------------

function sizeOf(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length
  try {
    const json = JSON.stringify(result)
    return json === undefined ? undefined : Buffer.byteLength(json)
  } catch {
    return undefined
  }
}

// Molti tool segnalano l'errore nel risultato invece di lanciare ({ error } o { success: false }),
// e la validazione dell'input di Mastra restituisce { error: true, message }. In quel caso il
// messaggio contiene gli argomenti ricevuti (anche il contenuto di una scrittura): si tiene solo
// la prima riga, che è la frase di sintesi.
function failureOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as { error?: unknown; success?: unknown; message?: unknown }
  if (r.error === true) return shortError(typeof r.message === 'string' ? r.message : 'errore')
  if (typeof r.error === 'string') return shortError(r.error)
  if (r.success === false) return 'errore'
  return undefined
}

export interface ExecutableTool {
  execute?: (input: never, context: never) => unknown
}

/**
 * Avvolge un tool perché ogni chiamata produca un evento `audit` e aggiorni le metriche, senza
 * che il tool sappia nulla. `name` è la chiave con cui il tool è registrato (il nome MCP).
 * Il tool originale non viene modificato: se ne restituisce una copia con `execute` avvolto.
 * L'identità si legge a ogni chiamata con `currentPrincipal()`, non alla registrazione.
 */
export function withAudit<T extends ExecutableTool>(name: string, tool: T, ctx: AuditContext): T {
  const original = tool.execute
  if (!original) return tool
  const copy = Object.assign(Object.create(Object.getPrototypeOf(tool) as object | null) as T, tool)
  copy.execute = async (input: never, context: never) => {
    const start = performance.now()
    const args = reduceArgs(name, input, ctx.queryMaxChars)
    const state: CallState = {}
    try {
      const result = await callStates.run(state, () => original.call(tool, input, context))
      const durationMs = performance.now() - start
      const error = failureOf(result)
      if (state.denied !== undefined) {
        // negata ma risposta identica a «non trovato»: nell'audit conta `denied`, non `error`
        recordToolCall(ctx, {
          tool: name,
          outcome: 'denied',
          durationMs,
          args,
          resultSize: sizeOf(result),
          reason: state.denied,
        })
      } else {
        recordToolCall(
          ctx,
          error === undefined
            ? { tool: name, outcome: 'ok', durationMs, args, resultSize: sizeOf(result) }
            : { tool: name, outcome: 'error', durationMs, args, error },
        )
      }
      return result
    } catch (e) {
      const durationMs = performance.now() - start
      if (e instanceof DeniedError) {
        recordToolCall(ctx, {
          tool: name,
          outcome: 'denied',
          durationMs,
          args,
          reason: sanitizeString(e.reason, 200),
        })
      } else {
        recordToolCall(ctx, {
          tool: name,
          outcome: 'error',
          durationMs,
          args,
          error: shortError(e),
        })
      }
      throw e
    }
  }
  return copy
}

/** Applica `withAudit` a un insieme di tool, usando le chiavi come nomi. */
export function auditTools<T extends Record<string, ExecutableTool>>(
  tools: T,
  ctx: AuditContext,
): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, withAudit(name, tool, ctx)]),
  ) as T
}
