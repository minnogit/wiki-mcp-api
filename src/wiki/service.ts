import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import matter from 'gray-matter'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { rankPages, substringMatches, type RankedPage } from './search-index.js'
import { getWikiSource, type WikiSource } from './freshness.js'
import { currentPrincipal, type Principal } from '../auth.js'
import { log } from '../log.js'
import type { ProposalsConfig } from '../config.js'
import { markDenied, type DeniedReason } from '../audit.js'
import {
  VISIBILITA,
  authorize,
  parseAccess,
  visibleTo,
  type AccessFields,
  type Visibilita,
} from './access.js'

const execFileAsync = promisify(execFile)

const LOCK_OPTS = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10_000,
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false,
  )
}

async function withFileLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  if (!(await exists(targetPath))) await fsp.writeFile(targetPath, '', 'utf-8')
  const release = await lockfile.lock(targetPath, LOCK_OPTS)
  try {
    return await fn()
  } finally {
    await release()
  }
}

/**
 * Contesto di una wiki: tutto ciò che il service sa di essa. Niente variabili d'ambiente
 * né stato di modulo: più wiki nello stesso processo hanno ciascuna il proprio contesto.
 */
export interface WikiContext {
  /** identificativo della wiki (`[a-z0-9-]+`), usato per il routing HTTP e nei messaggi */
  name: string
  /** cartella delle pagine (scrivibile da stdio), percorso assoluto */
  wikiDir: string
  /** cartella delle sorgenti (sola lettura), percorso assoluto; assente se la wiki non ha sorgenti */
  rawDir?: string
  /** riga che descrive il dominio documentato, per le `instructions` del client MCP */
  domain?: string
  /** fuso IANA con cui rendere le date derivate dall'mtime; assente = fuso del processo */
  tz?: string
  /**
   * Proposte di modifica da remoto (solo configurazione: il service non le usa). Senza, il tool
   * `wikiProposePage` non è montato per questa wiki.
   */
  proposals?: ProposalsConfig
}

export interface PageFrontmatter {
  tipo?: string
  tags: string[]
  fonti: string[]
  aggiornato?: string
  stato?: string
  /** Presente solo se il campo c'è nel file. Un valore sconosciuto è già normalizzato a `riservata`. */
  visibilita?: Visibilita
  /** Presente solo se non vuota. Conta solo con `visibilita: riservata`. */
  gruppi?: string[]
  /** Il valore sconosciuto di `visibilita` (troncato), per far notare il refuso a chi può leggere la pagina. */
  visibilitaNonValida?: string
}

export interface Page {
  path: string
  slug: string
  title: string
  frontmatter: PageFrontmatter
  content: string
  links: string[]
  updatedAt: string
}

export type PageMeta = Omit<Page, 'content' | 'links'> & { score?: number; snippet?: string }

export interface SearchOpts {
  q?: string
  tag?: string
  tipo?: string
  stato?: string
  topK?: number
}

export interface WikiStatus {
  totalPages: number
  byTipo: Record<string, number>
  byStato: Record<string, number>
  lastUpdated: string
  /** presente solo se la wiki sta dentro un checkout git leggibile */
  source?: WikiSource
}

function extractTitle(content: string, filePath: string): string {
  const match = /^#[ \t]+(\S.*)$/m.exec(content)
  return match ? match[1].trim() : path.basename(filePath, '.md')
}

// Link markdown standard verso altre pagine (`[testo](altra.md)`, `[testo](/cartella/altra.md#sez)`),
// la convenzione di OKF. Il path è relativo alla cartella della pagina, o alla radice della wiki
// se inizia con "/". Restano fuori URL esterni, file non .md e path che escono dalla wiki.
const MARKDOWN_LINK_RE = /\[[^\][]*\]\(<?([^()\s>]+)>?(?:\s+"[^"]*")?\)/g
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

function markdownLinkToSlug(target: string, fromPath: string): string | undefined {
  if (URL_SCHEME_RE.test(target)) return undefined
  const suffixStart = target.search(/[#?]/)
  let rel = suffixStart === -1 ? target : target.slice(0, suffixStart)
  try {
    rel = decodeURIComponent(rel)
  } catch {
    // percent-encoding malformato: si usa il target com'è
  }
  if (!rel.endsWith('.md')) return undefined
  const joined = rel.startsWith('/')
    ? path.posix.normalize(rel.slice(1))
    : path.posix.join(path.posix.dirname(fromPath.split(path.sep).join('/')), rel)
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return undefined
  return joined.replace(/\.md$/, '')
}

function extractLinks(content: string, fromPath: string): string[] {
  const links: string[] = []
  const wikilink = /\[\[([^\][|]+)(?:\|[^\][]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikilink.exec(content)) !== null) links.push(m[1].trim())
  while ((m = MARKDOWN_LINK_RE.exec(content)) !== null) {
    const slug = markdownLinkToSlug(m[1], fromPath)
    if (slug) links.push(slug)
  }
  return [...new Set(links)]
}

async function scanDir(
  dir: string,
  base: string,
  filter: (name: string) => boolean = () => true,
): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry): Promise<string[]> => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return scanDir(full, base, filter)
        if (entry.isFile() && filter(entry.name)) return [path.relative(base, full)]
        return []
      }),
  )
  return nested.flat()
}

// Fuso con cui rendere le date derivate dall'mtime (YYYY-MM-DD). Di default si usa
// quello del processo, ma su deploy remoti il fuso della macchina non c'entra con
// quello di chi usa la wiki: il campo `tz` del contesto (es. "Europe/Rome") lo fissa.
function instantToDate(ms: number, tz?: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = new Date(ms)
  if (!tz) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

async function parsePage(
  relPath: string,
  full: string,
  stat: fs.Stats,
  tz?: string,
): Promise<Page> {
  const raw = await fsp.readFile(full, 'utf-8')
  const { data, content } = matter(raw) as { data: Record<string, unknown>; content: string }
  const stringOrUndefined = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined
  const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  // come in validateFrontmatter: una data YAML non quotata arriva come Date, va riportata a YYYY-MM-DD
  const access = parseAccess(data)
  const aggiornato =
    data.aggiornato instanceof Date
      ? data.aggiornato.toISOString().slice(0, 10)
      : stringOrUndefined(data.aggiornato)
  return {
    path: relPath,
    slug: relPath.replace(/\.md$/, ''),
    title: extractTitle(content, relPath),
    frontmatter: {
      tipo: stringOrUndefined(data.tipo),
      tags: stringList(data.tags),
      fonti: stringList(data.fonti),
      aggiornato,
      stato: stringOrUndefined(data.stato),
      ...(access.visibilita ? { visibilita: access.visibilita } : {}),
      ...(access.gruppi.length > 0 ? { gruppi: access.gruppi } : {}),
      ...(access.visibilitaNonValida ? { visibilitaNonValida: access.visibilitaNonValida } : {}),
    },
    content: content.trim(),
    links: extractLinks(content, relPath),
    updatedAt: instantToDate(stat.mtimeMs, tz),
  }
}

const RESERVED_ROOT_FILES = new Set(['index.md', 'log.md', 'sources.md', 'overview.md'])

/** File riservati della radice (index, log, sources, overview): gestiti dal flusso di INGEST, non proponibili. */
export function isReservedRootFile(relPath: string): boolean {
  return path.dirname(relPath) === '.' && RESERVED_ROOT_FILES.has(path.basename(relPath))
}

// Permessi per pagina: campi opzionali, validati qui in scrittura. In lettura un valore sbagliato
// non blocca nulla ma vale `riservata` (fail-closed, vedi access.ts).
const ACCESS_SHAPE = {
  visibilita: z
    .enum(VISIBILITA, { errorMap: () => ({ message: 'deve essere pubblica|interna|riservata' }) })
    .optional(),
  gruppi: z
    .array(z.string().trim().min(1, 'non deve contenere nomi vuoti'), {
      errorMap: () => ({ message: 'deve essere una lista di nomi di gruppo' }),
    })
    .optional(),
}

const FRONTMATTER_SCHEMA = z.object({
  tipo: z.enum(['concetto', 'soggetto', 'procedura', 'normativa', 'entita', 'analisi'], {
    errorMap: () => ({
      message: 'deve essere uno tra concetto|soggetto|procedura|normativa|entita|analisi',
    }),
  }),
  tags: z.array(z.string()).min(1, 'deve contenere almeno un tag'),
  fonti: z.array(z.string()),
  // YAML interpreta date non quotate (YYYY-MM-DD) come Date: normalizza prima di validare il formato.
  aggiornato: z.preprocess(
    (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'deve avere formato YYYY-MM-DD'),
  ),
  stato: z.enum(['bozza', 'stabile', 'da-rivedere']),
  ...ACCESS_SHAPE,
})

/**
 * Valida il frontmatter in scrittura e restituisce eventuali avvisi (non bloccanti). I file
 * riservati di radice sono esenti, ma se dichiarano `visibilita`/`gruppi` quei due campi sono
 * validati comunque: un refuso lì renderebbe il file invisibile (fail-closed) senza spiegazioni.
 */
export function validateFrontmatter(relPath: string, content: string): string[] {
  const isReserved =
    path.dirname(relPath) === '.' && RESERVED_ROOT_FILES.has(path.basename(relPath))
  const { data } = matter(content)
  const result = (isReserved ? z.object(ACCESS_SHAPE) : FRONTMATTER_SCHEMA).safeParse(data)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(radice)'} ${i.message}`)
      .join('; ')
    throw new Error(`Frontmatter non valido in ${relPath}: ${issues}`)
  }
  const { visibilita, gruppi } = result.data
  return gruppi && gruppi.length > 0 && visibilita !== 'riservata'
    ? [`gruppi ignorato: ha effetto solo con visibilita: riservata (in ${relPath})`]
    : []
}

/**
 * Stato di una pagina rispetto a una proposta di modifica del principal corrente:
 * - `missing`: il file non esiste nel clone servito (proposta di creazione);
 * - `forbidden`: esiste ma il principal non può scriverla (o non è un file leggibile);
 *   chi chiama deve rispondere come per un percorso non consentito, senza dire che esiste;
 * - `existing`: esiste ed è scrivibile; `access` sono i suoi campi di accesso attuali.
 */
export type ProposalTarget =
  | { kind: 'missing' }
  | { kind: 'forbidden'; reason: DeniedReason }
  | { kind: 'existing'; access: AccessFields }

export interface RawFileInfo {
  filename: string
  checksum: string
}

export type RawDiffResult =
  | { status: 'diff'; base: string; diff: string; truncated: boolean }
  | { status: 'unchanged' | 'binary' | 'untracked' | 'no-git' | 'baseline-not-found' }

const RAW_DIFF_MAX_CHARS = 200_000
const RAW_DIFF_MAX_COMMITS = 500
const CHECKSUM_RE = /^[0-9a-f]{12}$/i

// Il driver `pdf` è definito qui e non nella config git della macchina: la wiki collegata
// deve solo mapparlo nei suoi .gitattributes (`*.pdf diff=pdf`). Senza `pdftotext` git
// ripiega su "Binary files differ" e rawDiff risponde 'binary'.
// Git accoda il file come ultimo argomento (qui diventa $0); pdftotext deve scrivere su stdout (`-`).
const GIT_DIFF_DRIVERS = ['-c', 'diff.pdf.textconv=sh -c \'exec pdftotext -layout "$0" -\'']

async function checksumIn(dir: string, relPath: string): Promise<string> {
  const full = path.resolve(dir, relPath)
  if (!full.startsWith(dir + path.sep)) throw new Error('Path fuori dalla directory consentita')
  let st: fs.Stats
  try {
    st = await fsp.stat(full)
  } catch (e) {
    if (isEnoent(e)) throw new Error(`File non trovato: ${relPath}`)
    throw e
  }
  if (!st.isFile()) throw new Error(`File non trovato: ${relPath}`)
  const buf = await fsp.readFile(full)
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)
}

export interface Graph {
  forward: Record<string, string[]>
  reverse: Record<string, string[]>
  orphans: string[]
}

const EXCLUDED_FROM_ORPHANS = new Set([...RESERVED_ROOT_FILES].map((f) => f.replace(/\.md$/, '')))

// Un wikilink si scrive col solo nome della pagina ([[git-submodule]]) anche se la pagina sta in
// una sottocartella (concetti/git-submodule), come in Obsidian. Si risolve così: slug esatto, poi
// unica pagina con quel nome, poi, se il nome è ambiguo, la pagina nella stessa cartella di chi
// linka. Se nessuna regola decide, il link resta com'è e compare in `reverse` come link rotto.
function resolveLink(
  link: string,
  fromSlug: string,
  slugs: Set<string>,
  byName: Map<string, string[]>,
): string {
  if (slugs.has(link)) return link
  const candidates =
    byName.get(path.posix.basename(link))?.filter((s) => s.endsWith('/' + link)) ?? []
  if (candidates.length === 1) return candidates[0]
  const sameDir = path.posix.join(path.posix.dirname(fromSlug), link)
  return candidates.includes(sameDir) ? sameDir : link
}

// La data semantica è il frontmatter `aggiornato` (YYYY-MM-DD, già normalizzato da
// YAML); se assente o malformato si ripiega sulla data del file.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface WikiServiceOptions {
  /** Da dove leggere il principal per i permessi di pagina; default `currentPrincipal`. */
  principal?: () => Principal | undefined
}

/**
 * Crea il service di una wiki, legato al suo contesto. Cache di parsing e percorsi sono
 * locali alla chiamata: due service nello stesso processo non condividono nulla.
 */
export function createWikiService(ctx: WikiContext, options: WikiServiceOptions = {}) {
  // Identità per cui filtrare: di default quella della richiesta corrente, letta a ogni chiamata
  // (mai catturata alla creazione: il service è uno per wiki, le richieste sono di utenti diversi).
  // `undefined` = locale, fiducia piena. Nei test si può passare un'altra sorgente.
  const principalNow = options.principal ?? currentPrincipal
  const wikiDir = path.resolve(ctx.wikiDir)
  const rawDir = ctx.rawDir ? path.resolve(ctx.rawDir) : undefined

  function requireRaw(): string {
    if (!rawDir) throw new Error(`Sorgenti raw non configurate per la wiki "${ctx.name}"`)
    return rawDir
  }

  // Cache di parsing per singolo file: evita di rileggere/riparsare tutto il corpus a
  // ogni chiamata tool. Validità basata su (mtimeMs, size): scritture via writePage/
  // appendLog ed edit esterni cambiano l'mtime e invalidano da sole; le voci dei file
  // eliminati vengono rimosse in getAllPages. Le Page condivise dalla cache sono da
  // trattare come immutabili (nessun consumer le muta mai in place).
  const pageCache = new Map<string, { key: string; page: Page }>()

  async function parsePageCached(relPath: string, full: string): Promise<Page> {
    const stat = await fsp.stat(full)
    const key = `${stat.mtimeMs}:${stat.size}`
    const hit = pageCache.get(full)
    if (hit?.key === key) return hit.page
    const page = await parsePage(relPath, full, stat, ctx.tz)
    // una volta per versione del file (cache miss): il refuso va segnalato, la pagina resta riservata
    if (page.frontmatter.visibilitaNonValida !== undefined)
      log().warn('page-visibility-invalid', {
        msg: 'valore di visibilita sconosciuto: la pagina è trattata come riservata',
        wiki: ctx.name,
        page: relPath,
        value: page.frontmatter.visibilitaNonValida,
      })
    pageCache.set(full, { key, page })
    return page
  }

  // TUTTE le pagine, nascoste comprese: uso interno, mai restituito così com'è. Ogni percorso
  // pubblico del service passa da `visiblePages()` o da un controllo `authorize` per pagina.
  async function loadAllPages(): Promise<Page[]> {
    const seen = new Set<string>()
    const pages = await Promise.all(
      (await scanDir(wikiDir, wikiDir, (name) => name.endsWith('.md'))).map(async (rel) => {
        const full = path.join(wikiDir, rel)
        seen.add(full)
        return parsePageCached(rel, full)
      }),
    )
    for (const key of pageCache.keys()) if (!seen.has(key)) pageCache.delete(key)
    return pages
  }

  // Le pagine che il principal corrente può leggere. Il filtro si applica a ogni chiamata, per
  // principal: la cache di parsing resta per pagina e non contiene risultati filtrati. Tutto ciò
  // che aggrega (corpus per IDF e vocabolario della ricerca, grafo, conteggi) deve partire da qui,
  // altrimenti punteggi, refusi tollerati o totali rivelano l'esistenza delle pagine nascoste.
  async function visiblePages(): Promise<Page[]> {
    return (await loadAllPages()).filter(visibleTo(principalNow()))
  }

  /** Le pagine visibili al principal corrente (le nascoste non compaiono). */
  async function getAllPages(): Promise<Page[]> {
    return visiblePages()
  }

  /**
   * Una pagina per slug. Una pagina esistente ma non permessa restituisce `null`, come una
   * inesistente: il chiamante non deve poter distinguere i due casi. La differenza resta solo
   * nell'audit (`markDenied`).
   */
  async function getPage(slug: string): Promise<Page | null> {
    const relPath = slug.endsWith('.md') ? slug : slug + '.md'
    const full = path.join(wikiDir, relPath)
    if (!full.startsWith(wikiDir + path.sep)) return null
    let page: Page
    try {
      page = await parsePageCached(relPath, full)
    } catch (e) {
      if (isEnoent(e)) return null
      throw e
    }
    const decision = authorize(page, principalNow(), 'read')
    if (!decision.allowed) {
      markDenied(decision.reason)
      return null
    }
    return page
  }

  async function searchPages(opts: SearchOpts): Promise<PageMeta[]> {
    // Corpus = sole pagine visibili: IDF, vocabolario per i refusi e snippet non devono
    // dipendere da pagine che il chiamante non può vedere.
    const allPages = await visiblePages()
    // Senza un limite, una query che matcha molte pagine restituisce un output
    // potenzialmente enorme (metadati + snippet per ogni pagina), che i client MCP
    // troncano per proteggere il context window — perdendo magari proprio le pagine
    // più rilevanti finite in coda. Limitiamo quindi ai topK risultati migliori.
    // Con `q` i risultati sono ordinati per score: i primi 10 sono i più rilevanti.
    // Senza `q` (solo filtro tag/tipo/stato) non c'è alcun ranking, quindi tagliare
    // a 10 sarebbe arbitrario — usiamo un default più alto in quel caso.
    const topK = opts.topK ?? (opts.q ? 10 : 50)

    const filtered = allPages.filter((p) => {
      if (opts.tipo && p.frontmatter.tipo !== opts.tipo) return false
      if (opts.stato && p.frontmatter.stato !== opts.stato) return false
      if (opts.tag && !p.frontmatter.tags?.some((t) => t.toLowerCase() === opts.tag!.toLowerCase()))
        return false
      return true
    })

    if (!opts.q) return filtered.slice(0, topK).map(({ content, links, ...meta }) => meta)

    const toMeta = ({ page, snippet }: RankedPage<Page>, score?: number): PageMeta => {
      const { content, links, ...meta } = page
      return { ...meta, ...(score === undefined ? {} : { score }), snippet }
    }

    const ranked = rankPages(allPages, filtered, opts.q)
    // query senza token utili (es. solo stopword/simboli): fallback a substring match
    if (!ranked)
      return substringMatches(filtered, opts.q)
        .slice(0, topK)
        .map((r) => toMeta(r))
    return ranked.slice(0, topK).map((r) => toMeta(r, r.score))
  }

  // Restituisce gli avvisi non bloccanti della validazione (es. `gruppi` su pagina non riservata).
  // Nessun controllo `canWrite` qui: la scrittura esiste solo su stdio (fiducia piena). La
  // scrittura remota della PR successiva lo chiamerà con il principal della richiesta.
  async function writePage(relPath: string, content: string): Promise<string[]> {
    if (!relPath.endsWith('.md')) throw new Error('Solo file .md sono consentiti')
    const full = path.resolve(wikiDir, relPath)
    if (!full.startsWith(wikiDir + path.sep)) throw new Error('Path fuori dalla wiki directory')
    const warnings = validateFrontmatter(relPath, content)
    await withFileLock(full, () => fsp.writeFile(full, content, 'utf-8'))
    return warnings
  }

  // Stato di `relPath` per una proposta di modifica: serve a `src/proposals.ts` per decidere
  // creazione/modifica e per i permessi. Non restituisce mai il contenuto, e per una pagina
  // esistente ma non scrivibile dice solo `forbidden` (nessun dettaglio sulla pagina).
  async function proposalTarget(relPath: string): Promise<ProposalTarget> {
    const full = path.resolve(wikiDir, relPath)
    if (!full.startsWith(wikiDir + path.sep))
      return { kind: 'forbidden', reason: 'path-not-allowed' }
    let page: Page
    try {
      page = await parsePageCached(relPath, full)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (isEnoent(e)) return { kind: 'missing' }
      // una cartella, o altro che non è un file normale: non è una pagina su cui proporre
      if (code === 'EISDIR' || code === 'ENOTDIR')
        return { kind: 'forbidden', reason: 'path-not-allowed' }
      throw e
    }
    const decision = authorize(page, principalNow(), 'write')
    if (!decision.allowed) return { kind: 'forbidden', reason: decision.reason }
    const { visibilita, gruppi, visibilitaNonValida } = page.frontmatter
    return { kind: 'existing', access: { visibilita, gruppi, visibilitaNonValida } }
  }

  async function appendLog(entry: string): Promise<void> {
    const logPath = path.join(wikiDir, 'log.md')
    await withFileLock(logPath, () => fsp.appendFile(logPath, '\n' + entry + '\n', 'utf-8'))
  }

  // Ricorsivo: i filename restituiti sono path relativi a rawDir (es. "verbali/2026-01.md"),
  // così due file con lo stesso basename in sottocartelle diverse restano distinguibili sia
  // qui sia in wiki/sources.md (che li registra come "raw/<path completo>").
  async function listRaw(): Promise<RawFileInfo[]> {
    const rawDir = requireRaw()
    const relPaths = await scanDir(rawDir, rawDir)
    return Promise.all(
      relPaths.map(async (filename) => ({
        filename,
        checksum: await checksumIn(rawDir, filename),
      })),
    )
  }

  async function readRaw(filename: string): Promise<string> {
    const rawDir = requireRaw()
    const full = path.resolve(rawDir, filename)
    if (path.isAbsolute(filename) || !full.startsWith(rawDir + path.sep))
      throw new Error('Filename non valido')
    try {
      return await fsp.readFile(full, 'utf-8')
    } catch (e) {
      if (isEnoent(e)) throw new Error(`File raw non trovato: ${filename}`)
      throw e
    }
  }

  function runGit(args: string[]): Promise<string> {
    const rawDir = requireRaw()
    return execFileAsync(
      'git',
      [...GIT_DIFF_DRIVERS, '--literal-pathspecs', '-C', rawDir, ...args],
      {
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: 'cat' },
      },
    ).then((r) => r.stdout)
  }

  // Trova il commit in cui il file aveva il checksum registrato in sources.md (stessa
  // definizione di fileChecksum: sha256 sul contenuto grezzo, primi 12 hex). Si ancora al
  // contenuto e non a un hash di commit annotato a mano, che può non corrispondere.
  async function findCommitByChecksum(filename: string, checksum: string): Promise<string | null> {
    const rawDir = requireRaw()
    const commits = (
      await runGit(['log', `-n${RAW_DIFF_MAX_COMMITS}`, '--format=%H', '--', filename])
    )
      .split('\n')
      .filter(Boolean)
    for (const commit of commits) {
      let blob: Buffer
      try {
        blob = (
          await execFileAsync('git', ['-C', rawDir, 'show', `${commit}:./${filename}`], {
            encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024,
          })
        ).stdout
      } catch {
        continue
      }
      if (
        crypto.createHash('sha256').update(blob).digest('hex').slice(0, 12) ===
        checksum.toLowerCase()
      )
        return commit
    }
    return null
  }

  async function rawDiff(filename: string, sinceChecksum?: string): Promise<RawDiffResult> {
    const rawDir = requireRaw()
    const full = path.resolve(rawDir, filename)
    if (path.isAbsolute(filename) || !full.startsWith(rawDir + path.sep))
      throw new Error('Filename non valido')
    if (sinceChecksum !== undefined && !CHECKSUM_RE.test(sinceChecksum))
      throw new Error('sinceChecksum deve essere di 12 caratteri esadecimali')
    try {
      await fsp.access(full)
    } catch (e) {
      if (isEnoent(e)) throw new Error(`File raw non trovato: ${filename}`)
      throw e
    }

    try {
      await runGit(['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { status: 'no-git' }
    }
    try {
      await runGit(['ls-files', '--error-unmatch', '--', filename])
    } catch {
      return { status: 'untracked' }
    }

    const diffOpts = ['--no-color', '--no-ext-diff']
    let base: string
    let out: string
    try {
      if (sinceChecksum) {
        const commit = await findCommitByChecksum(filename, sinceChecksum)
        if (!commit) return { status: 'baseline-not-found' }
        base = commit
        out = await runGit(['diff', ...diffOpts, commit, '--', filename])
      } else {
        base = 'HEAD'
        out = await runGit(['diff', ...diffOpts, 'HEAD', '--', filename])
        if (!out.trim()) {
          const last = (await runGit(['log', '-n1', '--format=%H', '--', filename])).trim()
          if (last) {
            base = `${last}^`
            out = await runGit(['show', ...diffOpts, '--format=', last, '--', filename])
          }
        }
      }
    } catch (e) {
      throw new Error(
        `git diff fallito: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim()}`,
      )
    }

    if (!out.trim()) return { status: 'unchanged' }
    if (
      out.split('\n').some((line) => line.startsWith('Binary files ') && line.endsWith(' differ'))
    )
      return { status: 'binary' }
    const truncated = out.length > RAW_DIFF_MAX_CHARS
    return {
      status: 'diff',
      base,
      diff: truncated ? out.slice(0, RAW_DIFF_MAX_CHARS) : out,
      truncated,
    }
  }

  // Accetta solo path relativi a wiki/ o raw/: in caso di omonimia vince la copia in
  // wiki/ (fonte già ingerita). Niente path assoluti, per coerenza col boundary
  // wiki/ scrivibile / raw/ leggibile.
  async function fileChecksum(relPath: string): Promise<string> {
    if (path.isAbsolute(relPath))
      throw new Error('Solo path relativi a wiki/ o raw/ sono consentiti')
    const w = path.resolve(wikiDir, relPath)
    const r = rawDir ? path.resolve(rawDir, relPath) : undefined
    // Una pagina nascosta non deve rivelare esistenza né hash: si comporta come se in wiki/ non ci
    // fosse (si passa a raw/, poi «File non trovato», come per un file inesistente).
    if (
      w.startsWith(wikiDir + path.sep) &&
      (await exists(w)) &&
      (!relPath.endsWith('.md') || (await getPage(relPath)) !== null)
    )
      return checksumIn(wikiDir, relPath)
    if (rawDir && r?.startsWith(rawDir + path.sep) && (await exists(r)))
      return checksumIn(rawDir, relPath)
    throw new Error(`File non trovato: ${relPath}`)
  }

  // Come se le pagine nascoste non esistessero: un link verso una di esse resta nel grafo come
  // link verso una pagina inesistente (appare in `forward` e come chiave di `reverse`), identico
  // a ciò che si vedrebbe senza quella pagina. Omettere solo i link verso le nascoste le
  // distinguerebbe dalle pagine davvero inesistenti, cioè ne rivelerebbe l'esistenza.
  async function getGraph(): Promise<Graph> {
    const pages = await visiblePages()
    const forward: Record<string, string[]> = {}
    const reverse: Record<string, string[]> = {}

    const slugs = new Set(pages.map((p) => p.slug))
    const byName = new Map<string, string[]>()
    for (const s of slugs) {
      const name = path.posix.basename(s)
      byName.set(name, [...(byName.get(name) ?? []), s])
    }

    for (const p of pages) {
      forward[p.slug] = [...new Set(p.links.map((l) => resolveLink(l, p.slug, slugs, byName)))]
      reverse[p.slug] = reverse[p.slug] ?? []
    }
    for (const p of pages) {
      for (const linked of forward[p.slug]) {
        reverse[linked] = [...(reverse[linked] ?? []), p.slug]
      }
    }

    const orphans = pages
      .filter((p) => !EXCLUDED_FROM_ORPHANS.has(p.slug) && (reverse[p.slug]?.length ?? 0) === 0)
      .map((p) => p.slug)

    return { forward, reverse, orphans }
  }

  async function getStatus(): Promise<WikiStatus> {
    const pages = await visiblePages()
    const byTipo: Record<string, number> = {}
    const byStato: Record<string, number> = {}
    let lastUpdated = ''
    for (const p of pages) {
      const t = p.frontmatter.tipo ?? 'senza-tipo'
      byTipo[t] = (byTipo[t] ?? 0) + 1
      const s = p.frontmatter.stato ?? 'senza-stato'
      byStato[s] = (byStato[s] ?? 0) + 1
      const a = p.frontmatter.aggiornato
      const updated = a && DATE_RE.test(a) ? a : p.updatedAt
      if (updated > lastUpdated) lastUpdated = updated
    }
    const status: WikiStatus = { totalPages: pages.length, byTipo, byStato, lastUpdated }
    const source = await getWikiSource(wikiDir)
    if (source) status.source = source
    return status
  }

  return {
    context: ctx,
    getAllPages,
    getPage,
    searchPages,
    writePage,
    proposalTarget,
    appendLog,
    listRaw,
    readRaw,
    rawDiff,
    fileChecksum,
    getGraph,
    getStatus,
  }
}

export type WikiService = ReturnType<typeof createWikiService>
