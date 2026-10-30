import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ConfigError } from './config.js'

const HASH_RE = /^sha256:[0-9a-f]{64}$/

// `id` compare nei log e nel CLI: caratteri semplici. `legacy` è riservato al token unico.
const ENTRY_SCHEMA = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'può contenere solo lettere, cifre, punto, _ e -')
      .refine((v) => v !== 'legacy', '«legacy» è riservato al token MCP_HTTP_TOKEN'),
    user: z.string().min(1, 'non può essere vuoto'),
    groups: z.array(z.string().min(1)).optional(),
    wikis: z.union([
      z.literal('*'),
      z.array(z.string().min(1)).min(1, 'elenca almeno una wiki, oppure "*"'),
    ]),
    tokenHash: z
      .string()
      .regex(HASH_RE, 'deve essere "sha256:" seguito da 64 cifre esadecimali minuscole'),
    expiresAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'non è una data ISO valida')
      .optional(),
    note: z.string().optional(),
  })
  .strict()

const FILE_SCHEMA = z.array(ENTRY_SCHEMA).superRefine((entries, ctx) => {
  const ids = new Set<string>()
  const hashes = new Set<string>()
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `id duplicato "${entry.id}": deve essere univoco`,
      })
    }
    ids.add(entry.id)
    if (hashes.has(entry.tokenHash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'tokenHash'],
        message: "stesso hash di un'altra voce",
      })
    }
    hashes.add(entry.tokenHash)
  })
})

export type TokenEntry = z.infer<typeof ENTRY_SCHEMA>

/**
 * Valida il contenuto (già parsato da JSON) del file dei token. Con `wikiNames` verifica che
 * ogni wiki citata esista (a meno di `"*"`); il CLI non conosce le wiki e lo omette.
 */
export function parseTokenFile(data: unknown, wikiNames?: readonly string[]): TokenEntry[] {
  const result = FILE_SCHEMA.safeParse(data)
  const problems: string[] = []
  if (!result.success) {
    for (const i of result.error.issues) {
      problems.push(`${i.path.length ? i.path.join('.') : '(radice)'}: ${i.message}`)
    }
  } else if (wikiNames) {
    result.data.forEach((entry, index) => {
      if (entry.wikis === '*') return
      for (const w of entry.wikis) {
        if (!wikiNames.includes(w)) {
          problems.push(
            `${index}.wikis: la wiki "${w}" non esiste (configurate: ${wikiNames.join(', ')})`,
          )
        }
      }
    })
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `File dei token non valido:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
  }
  return result.success ? result.data : []
}

/** Legge e valida il file dei token. */
export function loadTokenFile(file: string, wikiNames?: readonly string[]): TokenEntry[] {
  const full = path.resolve(file)
  let text: string
  try {
    text = fs.readFileSync(full, 'utf-8')
  } catch (e) {
    throw new ConfigError(
      `MCP_HTTP_TOKENS_FILE: impossibile leggere ${full}: ${(e as Error).message}`,
    )
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new ConfigError(
      `MCP_HTTP_TOKENS_FILE: ${full} non è JSON valido: ${(e as Error).message}`,
    )
  }
  return parseTokenFile(data, wikiNames)
}

export interface TokenFileOptions {
  /** Intervallo minimo tra due controlli (stat) del file, in ms. Default 2000. */
  checkIntervalMs?: number
  now?: () => number
  /** Destinazione degli errori di ricarica. Default: console.error. */
  logger?: (message: string) => void
}

/**
 * Voci del file dei token, ricaricate quando il file cambia (inode, dimensione o mtime: un
 * `rename` atomico cambia l'inode) con uno `stat` al massimo ogni `checkIntervalMs`. Così una
 * revoca ha effetto senza riavvio. Il primo caricamento lancia `ConfigError`; dopo, un file
 * illegibile, invalido o sparito non cambia nulla: si tiene l'ultima versione valida e si logga
 * l'errore (una volta per ogni versione del file). Non si apre mai l'accesso per errore e non
 * si chiude tutto per un refuso. Vale anche per il file cancellato: le credenziali restano
 * quelle dell'ultima versione valida finché non c'è un file valido.
 */
export class TokenFileStore {
  private current: TokenEntry[]
  private signature: string | undefined
  private lastCheck: number
  private lastLogged: string | undefined
  private readonly interval: number
  private readonly now: () => number
  private readonly logger: (message: string) => void
  private readonly full: string

  constructor(
    file: string,
    private readonly wikiNames: readonly string[],
    options: TokenFileOptions = {},
  ) {
    this.full = path.resolve(file)
    this.interval = options.checkIntervalMs ?? 2000
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? ((m) => console.error(m))
    this.current = loadTokenFile(this.full, wikiNames)
    this.signature = this.statSignature()
    this.lastCheck = this.now()
  }

  entries(): readonly TokenEntry[] {
    const t = this.now()
    if (t - this.lastCheck >= this.interval) {
      this.lastCheck = t
      this.refresh()
    }
    return this.current
  }

  private statSignature(): string {
    const s = fs.statSync(this.full)
    return `${s.ino}:${s.size}:${s.mtimeMs}`
  }

  private fail(message: string): void {
    if (message === this.lastLogged) return
    this.lastLogged = message
    this.logger(`${message}\nMantengo l'ultima versione valida del file dei token.`)
  }

  private refresh(): void {
    let sig: string
    try {
      sig = this.statSignature()
    } catch (e) {
      this.fail(`File dei token non leggibile (${this.full}): ${(e as Error).message}`)
      return
    }
    if (sig === this.signature) return
    try {
      this.current = loadTokenFile(this.full, this.wikiNames)
      this.lastLogged = undefined
      this.logger(`File dei token ricaricato: ${this.current.length} voci.`)
    } catch (e) {
      this.fail((e as Error).message)
    }
    // anche dopo un errore: la stessa versione del file non si rilegge a ogni controllo
    this.signature = sig
  }
}

/**
 * Scrittura atomica: file temporaneo nella stessa cartella + rename. Il file nuovo eredita
 * modo e proprietario di quello esistente (così un servizio che lo legge via gruppo continua a
 * poterlo fare dopo un `revoke` eseguito da root); se non esiste nasce 0600.
 */
export function writeTokenFile(file: string, entries: readonly TokenEntry[]): void {
  const full = path.resolve(file)
  let mode = 0o600
  let owner: { uid: number; gid: number } | undefined
  try {
    const s = fs.statSync(full)
    mode = s.mode & 0o777
    owner = { uid: s.uid, gid: s.gid }
  } catch {
    // file nuovo
  }
  const tmp = path.join(
    path.dirname(full),
    `.${path.basename(full)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeFileSync(fd, JSON.stringify(entries, null, 2) + '\n')
    fs.fchmodSync(fd, mode)
    if (owner) {
      try {
        fs.fchownSync(fd, owner.uid, owner.gid)
      } catch {
        // senza privilegi non si può cambiare proprietario: resta quello di chi scrive
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(tmp, full)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}
