import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import matter from 'gray-matter'
import lockfile from 'proper-lockfile'
import { z } from 'zod'

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

function resolveDir(envVar: string, fallback: string): string {
  const val = process.env[envVar]
  if (!val) return path.resolve(fallback)
  return path.isAbsolute(val) ? val : path.resolve(val)
}

const WIKI_DIR = resolveDir('WIKI_PATH', './wiki')
const RAW_DIR = resolveDir('RAW_PATH', './raw')

export interface PageFrontmatter {
  tipo?: string
  tags: string[]
  fonti: string[]
  aggiornato?: string
  stato?: string
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
}

const STOPWORDS = new Set([
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'il', 'lo', 'la', 'i', 'gli', 'le',
  'un', 'uno', 'una', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'al', 'allo', 'alla',
  'ai', 'agli', 'alle', 'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle', 'nel', 'nello', 'nella',
  'nei', 'negli', 'nelle', 'che', 'e', 'o', 'ma', 'se', 'come', 'anche', 'non', 'più', 'meno',
  'si', 'ci', 'ne', 'è',
])

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-zà-ÿ0-9]+/g) ?? []
  return matches.filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

const FIELD_WEIGHTS = { title: 4, tags: 3, content: 1 }

function scorePage(page: Page, queryTerms: string[], docFreq: Map<string, number>, corpusSize: number): number {
  const titleCounts = termCounts(tokenize(page.title))
  const tagCounts = termCounts(tokenize(page.frontmatter.tags.join(' ')))
  const contentCounts = termCounts(tokenize(page.content))

  let score = 0
  for (const term of queryTerms) {
    const df = docFreq.get(term) ?? 0
    if (df === 0) continue
    const idf = Math.log(1 + corpusSize / df)
    const tf =
      FIELD_WEIGHTS.title * (titleCounts.get(term) ?? 0) +
      FIELD_WEIGHTS.tags * (tagCounts.get(term) ?? 0) +
      FIELD_WEIGHTS.content * (contentCounts.get(term) ?? 0)
    score += tf * idf
  }
  return score
}

const SNIPPET_CONTEXT_CHARS = 60

function buildSnippet(content: string, terms: string[]): string | undefined {
  if (terms.length === 0) return undefined
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const match = new RegExp(`(${escaped.join('|')})`, 'i').exec(content)
  if (!match) return undefined

  const start = Math.max(0, match.index - SNIPPET_CONTEXT_CHARS)
  const end = Math.min(content.length, match.index + match[0].length + SNIPPET_CONTEXT_CHARS)
  const body = content.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < content.length ? '…' : '')
}

function extractTitle(content: string, filePath: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : path.basename(filePath, '.md')
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) links.push(m[1].trim())
  return [...new Set(links)]
}

async function scanDir(dir: string, base: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await scanDir(full, base)))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.relative(base, full))
  }
  return files
}

// Cache di parsing per singolo file: evita di rileggere/riparsare tutto il corpus a
// ogni chiamata tool. Validità basata su (mtimeMs, size): scritture via writePage/
// appendLog ed edit esterni cambiano l'mtime e invalidano da sole; le voci dei file
// eliminati vengono rimosse in getAllPages. Le Page condivise dalla cache sono da
// trattare come immutabili (nessun consumer le muta mai in place).
const pageCache = new Map<string, { key: string; page: Page }>()

async function parsePage(relPath: string, full: string, stat: fs.Stats): Promise<Page> {
  const raw = await fsp.readFile(full, 'utf-8')
  const { data, content } = matter(raw)
  return {
    path: relPath,
    slug: relPath.replace(/\.md$/, ''),
    title: extractTitle(content, relPath),
    frontmatter: {
      tipo: data.tipo,
      tags: Array.isArray(data.tags) ? data.tags : [],
      fonti: Array.isArray(data.fonti) ? data.fonti : [],
      aggiornato: data.aggiornato ? String(data.aggiornato) : undefined,
      stato: data.stato,
    },
    content: content.trim(),
    links: extractWikilinks(content),
    updatedAt: stat.mtime.toISOString().split('T')[0],
  }
}

async function parsePageCached(relPath: string, full: string): Promise<Page> {
  const stat = await fsp.stat(full)
  const key = `${stat.mtimeMs}:${stat.size}`
  const hit = pageCache.get(full)
  if (hit && hit.key === key) return hit.page
  const page = await parsePage(relPath, full, stat)
  pageCache.set(full, { key, page })
  return page
}

export async function getAllPages(): Promise<Page[]> {
  const seen = new Set<string>()
  const pages = await Promise.all(
    (await scanDir(WIKI_DIR, WIKI_DIR)).map(async (rel) => {
      const full = path.join(WIKI_DIR, rel)
      seen.add(full)
      return parsePageCached(rel, full)
    }),
  )
  for (const key of pageCache.keys()) if (!seen.has(key)) pageCache.delete(key)
  return pages
}

export async function getPage(slug: string): Promise<Page | null> {
  const relPath = slug.endsWith('.md') ? slug : slug + '.md'
  const full = path.join(WIKI_DIR, relPath)
  if (!full.startsWith(WIKI_DIR + path.sep)) return null
  try {
    return await parsePageCached(relPath, full)
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

export async function searchPages(opts: SearchOpts): Promise<PageMeta[]> {
  const allPages = await getAllPages()
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
    if (opts.tag && !p.frontmatter.tags?.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) return false
    return true
  })

  if (!opts.q) return filtered.slice(0, topK).map(({ content, links, ...meta }) => meta)

  const queryTerms = [...new Set(tokenize(opts.q))]

  if (queryTerms.length === 0) {
    // query senza token utili (es. solo stopword/simboli): fallback a substring match
    const q = opts.q.toLowerCase()
    return filtered
      .filter((p) => [p.title, p.content, ...(p.frontmatter.tags ?? [])].join(' ').toLowerCase().includes(q))
      .slice(0, topK)
      .map((p) => ({ ...p, snippet: buildSnippet(p.content, [q]) }))
      .map(({ content, links, ...meta }) => meta)
  }

  const docFreq = new Map<string, number>()
  for (const p of allPages) {
    const tokens = new Set(tokenize([p.title, p.frontmatter.tags.join(' '), p.content].join(' ')))
    for (const term of queryTerms) {
      if (tokens.has(term)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }

  return filtered
    .map((p) => ({ ...p, score: scorePage(p, queryTerms, docFreq, allPages.length), snippet: buildSnippet(p.content, queryTerms) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ content, links, ...meta }) => meta)
}

const RESERVED_ROOT_FILES = new Set(['index.md', 'log.md', 'sources.md', 'overview.md'])

const FRONTMATTER_SCHEMA = z.object({
  tipo: z.enum(['concetto', 'soggetto', 'procedura', 'normativa', 'entita', 'analisi'], {
    errorMap: () => ({ message: 'deve essere uno tra concetto|soggetto|procedura|normativa|entita|analisi' }),
  }),
  tags: z.array(z.string()).min(1, 'deve contenere almeno un tag'),
  fonti: z.array(z.string()),
  // YAML interpreta date non quotate (YYYY-MM-DD) come Date: normalizza prima di validare il formato.
  aggiornato: z.preprocess(
    (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'deve avere formato YYYY-MM-DD'),
  ),
  stato: z.enum(['bozza', 'stabile', 'da-rivedere']),
})

function validateFrontmatter(relPath: string, content: string): void {
  const isReserved = path.dirname(relPath) === '.' && RESERVED_ROOT_FILES.has(path.basename(relPath))
  if (isReserved) return

  const { data } = matter(content)
  const result = FRONTMATTER_SCHEMA.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(radice)'} ${i.message}`).join('; ')
    throw new Error(`Frontmatter non valido in ${relPath}: ${issues}`)
  }
}

export async function writePage(relPath: string, content: string): Promise<void> {
  if (!relPath.endsWith('.md')) throw new Error('Solo file .md sono consentiti')
  const full = path.resolve(WIKI_DIR, relPath)
  if (!full.startsWith(WIKI_DIR + path.sep)) throw new Error('Path fuori dalla wiki directory')
  validateFrontmatter(relPath, content)
  await withFileLock(full, () => fsp.writeFile(full, content, 'utf-8'))
}

export async function appendLog(entry: string): Promise<void> {
  const logPath = path.join(WIKI_DIR, 'log.md')
  await withFileLock(logPath, () => fsp.appendFile(logPath, '\n' + entry + '\n', 'utf-8'))
}

export interface RawFileInfo {
  filename: string
  checksum: string
}

export async function listRaw(): Promise<RawFileInfo[]> {
  let names: string[]
  try {
    names = await fsp.readdir(RAW_DIR)
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
  const infos = await Promise.all(
    names.map(async (filename) => {
      if (!(await fsp.stat(path.join(RAW_DIR, filename))).isFile()) return null
      return { filename, checksum: await checksumIn(RAW_DIR, filename) }
    }),
  )
  return infos.filter((x): x is RawFileInfo => x !== null)
}

export async function readRaw(filename: string): Promise<string> {
  if (filename.includes('/') || filename.includes('..')) throw new Error('Filename non valido')
  const full = path.join(RAW_DIR, filename)
  try {
    return await fsp.readFile(full, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) throw new Error(`File raw non trovato: ${filename}`)
    throw e
  }
}

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

// Accetta solo path relativi a wiki/ o raw/: in caso di omonimia vince la copia in
// wiki/ (fonte già ingerita). Niente path assoluti, per coerenza col boundary
// wiki/ scrivibile / raw/ leggibile.
export async function fileChecksum(relPath: string): Promise<string> {
  if (path.isAbsolute(relPath)) throw new Error('Solo path relativi a wiki/ o raw/ sono consentiti')
  const w = path.resolve(WIKI_DIR, relPath)
  const r = path.resolve(RAW_DIR, relPath)
  if (w.startsWith(WIKI_DIR + path.sep) && (await exists(w))) return checksumIn(WIKI_DIR, relPath)
  if (r.startsWith(RAW_DIR + path.sep) && (await exists(r))) return checksumIn(RAW_DIR, relPath)
  throw new Error(`File non trovato: ${relPath}`)
}

export interface Graph {
  forward: Record<string, string[]>
  reverse: Record<string, string[]>
  orphans: string[]
}

const EXCLUDED_FROM_ORPHANS = new Set([...RESERVED_ROOT_FILES].map((f) => f.replace(/\.md$/, '')))

export async function getGraph(): Promise<Graph> {
  const pages = await getAllPages()
  const forward: Record<string, string[]> = {}
  const reverse: Record<string, string[]> = {}

  for (const p of pages) {
    forward[p.slug] = p.links
    reverse[p.slug] = reverse[p.slug] ?? []
  }
  for (const p of pages) {
    for (const linked of p.links) {
      reverse[linked] = [...(reverse[linked] ?? []), p.slug]
    }
  }

  const orphans = pages
    .filter((p) => !EXCLUDED_FROM_ORPHANS.has(p.slug) && (reverse[p.slug]?.length ?? 0) === 0)
    .map((p) => p.slug)

  return { forward, reverse, orphans }
}

export async function getStatus(): Promise<WikiStatus> {
  const pages = await getAllPages()
  const byTipo: Record<string, number> = {}
  const byStato: Record<string, number> = {}
  let lastUpdated = ''
  for (const p of pages) {
    const t = p.frontmatter.tipo ?? 'senza-tipo'
    byTipo[t] = (byTipo[t] ?? 0) + 1
    const s = p.frontmatter.stato ?? 'senza-stato'
    byStato[s] = (byStato[s] ?? 0) + 1
    if (p.updatedAt > lastUpdated) lastUpdated = p.updatedAt
  }
  return { totalPages: pages.length, byTipo, byStato, lastUpdated }
}
