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

/** Valori predefiniti delle proposte di modifica (vedi `ProposalsConfig`). */
export const PROPOSAL_DEFAULTS = {
  baseBranch: 'main',
  pathPrefix: 'wiki/',
  tokenEnv: 'GITHUB_TOKEN',
  botName: 'wiki-mcp-bot',
  botEmail: 'wiki-mcp-bot@users.noreply.github.com',
  apiUrl: 'https://api.github.com',
  maxContentChars: 100_000,
  maxRationaleChars: 1000,
  maxOpenPulls: 20,
  rateLimitMax: 10,
  rateLimitWindowSeconds: 3600,
} as const

// Un solo carattere di controllo (newline compresi) in questi campi finirebbe in un'intestazione,
// in un'autorità di commit o in un ref git: si accettano solo forme semplici.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NO_CONTROL = /^[^\u0000-\u001f\u007f<>]+$/

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

// Con `apiUrl` si può puntare a GitHub Enterprise o a un finto server di prova; il token viaggia
// nell'intestazione Authorization, quindi in chiaro (http) solo verso il loopback.
function validApiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  } catch {
    return false
  }
}

const PROPOSALS_SCHEMA = z
  .object({
    repo: z.string().regex(REPO_RE, 'deve avere la forma "proprietario/nome"'),
    baseBranch: z
      .string()
      .regex(BRANCH_RE, 'non è un nome di branch valido')
      .refine(
        (v) => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'),
        'nome non valido',
      )
      .default(PROPOSAL_DEFAULTS.baseBranch),
    // Cartella della wiki dentro il repo ("" se le pagine stanno nella radice).
    pathPrefix: z
      .string()
      .default(PROPOSAL_DEFAULTS.pathPrefix)
      .transform((v) =>
        v
          .trim()
          .replace(/^\.\/+/, '')
          .replace(/^\/+/, ''),
      )
      .refine((v) => !v.split('/').some((seg) => seg === '..'), 'non può contenere ".."')
      .refine((v) => /^[A-Za-z0-9._/-]*$/.test(v), 'può contenere solo lettere, cifre, . _ - e /')
      .transform((v) => (v === '' || v === '.' ? '' : v.replace(/\/+$/, '') + '/')),
    tokenEnv: z
      .string()
      .regex(ENV_NAME_RE, "è il NOME di una variabile d'ambiente, non il token")
      .default(PROPOSAL_DEFAULTS.tokenEnv),
    botName: z
      .string()
      .min(1)
      .max(100)
      .regex(NO_CONTROL, 'caratteri non ammessi')
      .default(PROPOSAL_DEFAULTS.botName),
    botEmail: z
      .string()
      .min(3)
      .max(200)
      .regex(NO_CONTROL, 'caratteri non ammessi')
      .default(PROPOSAL_DEFAULTS.botEmail),
    labels: z
      .array(z.string().min(1).max(50).regex(NO_CONTROL, 'caratteri non ammessi'))
      .max(10)
      .default([]),
    apiUrl: z
      .string()
      .refine(
        validApiUrl,
        'deve essere un URL https (http solo verso localhost), senza credenziali',
      )
      .transform((v) => v.replace(/\/+$/, ''))
      .default(PROPOSAL_DEFAULTS.apiUrl),
    maxContentChars: z
      .number()
      .int()
      .min(100)
      .max(900_000)
      .default(PROPOSAL_DEFAULTS.maxContentChars),
    maxRationaleChars: z
      .number()
      .int()
      .min(10)
      .max(5000)
      .default(PROPOSAL_DEFAULTS.maxRationaleChars),
    // Tetto alle PR di proposta aperte contemporaneamente (conteggio sul repo, max 100).
    maxOpenPulls: z.number().int().min(1).max(100).default(PROPOSAL_DEFAULTS.maxOpenPulls),
    rateLimitMax: z.number().int().min(1).max(1000).default(PROPOSAL_DEFAULTS.rateLimitMax),
    rateLimitWindowSeconds: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(PROPOSAL_DEFAULTS.rateLimitWindowSeconds),
  })
  .strict()

/**
 * Proposte di modifica da remoto per una wiki (campo `proposals` di WIKI_CONFIG), con i valori
 * predefiniti già applicati. Contiene il NOME della variabile d'ambiente del token GitHub
 * (`tokenEnv`), mai il token.
 */
export type ProposalsConfig = z.output<typeof PROPOSALS_SCHEMA>

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
    proposals: PROPOSALS_SCHEMA.optional(),
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
    ...(entry.proposals ? { proposals: entry.proposals } : {}),
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
