import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { WikiContext } from './wiki/service.js'

/** Nome della wiki unica quando non c'è WIKI_CONFIG (configurazione storica a variabili d'ambiente). */
export const DEFAULT_WIKI_NAME = 'default'

/** Errore di configurazione: il messaggio è pensato per essere mostrato così com'è all'avvio. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// `name` finisce nell'URL (`/mcp/<name>`): niente maiuscole, punti o altro che richieda escape.
const WIKI_ENTRY_SCHEMA = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'può contenere solo lettere minuscole, cifre e trattini ([a-z0-9-])'),
    wikiPath: z.string().min(1, 'non può essere vuoto'),
    rawPath: z.string().min(1, 'non può essere vuoto').optional(),
    domain: z.string().optional(),
    tz: z
      .string()
      .refine(isValidTimeZone, 'non è un fuso IANA valido (es. "Europe/Rome")')
      .optional(),
  })
  .strict()

const WIKI_CONFIG_SCHEMA = z
  .array(WIKI_ENTRY_SCHEMA)
  .min(1, 'deve elencare almeno una wiki')
  .superRefine((entries, ctx) => {
    const seen = new Set<string>()
    entries.forEach((entry, index) => {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'name'],
          message: `nome duplicato "${entry.name}": deve essere univoco`,
        })
      }
      seen.add(entry.name)
    })
  })

/**
 * Valida il contenuto (già parsato da JSON) di un file WIKI_CONFIG e lo trasforma in contesti.
 * I percorsi relativi si risolvono rispetto a `baseDir` (la cartella del file di configurazione).
 */
export function parseWikiConfig(data: unknown, baseDir: string): WikiContext[] {
  const result = WIKI_CONFIG_SCHEMA.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.length ? i.path.join('.') : '(radice)'}: ${i.message}`)
      .join('\n')
    throw new ConfigError(`WIKI_CONFIG non valido:\n${issues}`)
  }
  return result.data.map((entry) => ({
    name: entry.name,
    wikiDir: path.resolve(baseDir, entry.wikiPath),
    rawDir: entry.rawPath ? path.resolve(baseDir, entry.rawPath) : undefined,
    domain: entry.domain?.trim() || undefined,
    tz: entry.tz,
  }))
}

/** Legge e valida il file WIKI_CONFIG. */
export function loadWikiConfigFile(file: string): WikiContext[] {
  const full = path.resolve(file)
  let text: string
  try {
    text = fs.readFileSync(full, 'utf-8')
  } catch (e) {
    throw new ConfigError(`WIKI_CONFIG: impossibile leggere ${full}: ${(e as Error).message}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new ConfigError(`WIKI_CONFIG: ${full} non è JSON valido: ${(e as Error).message}`)
  }
  return parseWikiConfig(data, path.dirname(full))
}

/**
 * Elenco delle wiki configurate. Con WIKI_CONFIG si legge il file (e WIKI_PATH, RAW_PATH,
 * WIKI_DOMAIN, WIKI_TZ vengono ignorate: ogni wiki porta i suoi valori). Senza, c'è una sola
 * wiki chiamata `default`, configurata come sempre da quelle variabili.
 */
export function loadWikis(env: NodeJS.ProcessEnv = process.env): WikiContext[] {
  const configFile = env.WIKI_CONFIG?.trim()
  if (configFile) return loadWikiConfigFile(configFile)
  return [
    {
      name: DEFAULT_WIKI_NAME,
      wikiDir: path.resolve(env.WIKI_PATH || './wiki'),
      rawDir: path.resolve(env.RAW_PATH || './raw'),
      domain: env.WIKI_DOMAIN?.trim() || undefined,
      tz: env.WIKI_TZ || undefined,
    },
  ]
}

/**
 * Sceglie la wiki di un processo stdio. Senza `name` va bene solo se ce n'è una sola;
 * con più wiki bisogna dirlo (WIKI_NAME), altrimenti l'agente lavorerebbe sulla wiki sbagliata.
 */
export function selectWiki(wikis: WikiContext[], name?: string): WikiContext {
  const wanted = name?.trim()
  const names = wikis.map((w) => w.name).join(', ')
  if (!wanted) {
    if (wikis.length === 1) return wikis[0]
    throw new ConfigError(
      `Ci sono ${wikis.length} wiki configurate (${names}): indica quale servire con WIKI_NAME.`,
    )
  }
  const found = wikis.find((w) => w.name === wanted)
  if (!found) {
    throw new ConfigError(
      `WIKI_NAME="${wanted}" non corrisponde a nessuna wiki (disponibili: ${names}).`,
    )
  }
  return found
}
