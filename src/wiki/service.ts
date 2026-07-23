import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import matter from 'gray-matter'
import lockfile from 'proper-lockfile'
import { z } from 'zod'

const LOCK_OPTS = {
  retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
  stale: 10_000,
}

async function withFileLock<T>(targetPath: string, fn: () => T): Promise<T> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, '', 'utf-8')
  const release = await lockfile.lock(targetPath, LOCK_OPTS)
  try {
    return fn()
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

function scanDir(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...scanDir(full, base))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.relative(base, full))
  }
  return files
}

function parsePage(relPath: string): Page {
  const full = path.join(WIKI_DIR, relPath)
  const raw = fs.readFileSync(full, 'utf-8')
  const { data, content } = matter(raw)
  const stat = fs.statSync(full)
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

export function getAllPages(): Page[] {
  return scanDir(WIKI_DIR, WIKI_DIR).map(parsePage)
}

export function getPage(slug: string): Page | null {
  const relPath = slug.endsWith('.md') ? slug : slug + '.md'
  const full = path.join(WIKI_DIR, relPath)
  if (!fs.existsSync(full)) return null
  if (!full.startsWith(WIKI_DIR + path.sep)) return null
  return parsePage(relPath)
}

export function searchPages(opts: SearchOpts): PageMeta[] {
  const allPages = getAllPages()

  const filtered = allPages.filter((p) => {
    if (opts.tipo && p.frontmatter.tipo !== opts.tipo) return false
    if (opts.stato && p.frontmatter.stato !== opts.stato) return false
    if (opts.tag && !p.frontmatter.tags?.includes(opts.tag)) return false
    return true
  })

  if (!opts.q) return filtered.map(({ content, links, ...meta }) => meta)

  const queryTerms = [...new Set(tokenize(opts.q))]

  if (queryTerms.length === 0) {
    // query senza token utili (es. solo stopword/simboli): fallback a substring match
    const q = opts.q.toLowerCase()
    return filtered
      .filter((p) => [p.title, p.content, ...(p.frontmatter.tags ?? [])].join(' ').toLowerCase().includes(q))
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
  await withFileLock(full, () => fs.writeFileSync(full, content, 'utf-8'))
}

export async function appendLog(entry: string): Promise<void> {
  const logPath = path.join(WIKI_DIR, 'log.md')
  await withFileLock(logPath, () => fs.appendFileSync(logPath, '\n' + entry + '\n', 'utf-8'))
}

export function listRaw(): string[] {
  if (!fs.existsSync(RAW_DIR)) return []
  return fs.readdirSync(RAW_DIR).filter((f) => fs.statSync(path.join(RAW_DIR, f)).isFile())
}

export function readRaw(filename: string): string {
  if (filename.includes('/') || filename.includes('..')) throw new Error('Filename non valido')
  const full = path.join(RAW_DIR, filename)
  if (!fs.existsSync(full)) throw new Error(`File raw non trovato: ${filename}`)
  return fs.readFileSync(full, 'utf-8')
}

export function fileChecksum(filePath: string): string {
  let full = filePath
  if (!path.isAbsolute(filePath)) {
    const w = path.join(WIKI_DIR, filePath)
    const r = path.join(RAW_DIR, filePath)
    if (fs.existsSync(w)) full = w
    else if (fs.existsSync(r)) full = r
    else throw new Error(`File non trovato: ${filePath}`)
  }
  const buf = fs.readFileSync(full)
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)
}

export interface Graph {
  forward: Record<string, string[]>
  reverse: Record<string, string[]>
  orphans: string[]
}

const EXCLUDED_FROM_ORPHANS = new Set([...RESERVED_ROOT_FILES].map((f) => f.replace(/\.md$/, '')))

export function getGraph(): Graph {
  const pages = getAllPages()
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

export function getStatus(): WikiStatus {
  const pages = getAllPages()
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
