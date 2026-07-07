import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import matter from 'gray-matter'

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

export type PageMeta = Omit<Page, 'content' | 'links'>

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
  return getAllPages()
    .filter((p) => {
      if (opts.tipo && p.frontmatter.tipo !== opts.tipo) return false
      if (opts.stato && p.frontmatter.stato !== opts.stato) return false
      if (opts.tag && !p.frontmatter.tags?.includes(opts.tag)) return false
      if (opts.q) {
        const q = opts.q.toLowerCase()
        const hay = [p.title, p.content, ...(p.frontmatter.tags ?? [])].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    .map(({ content, links, ...meta }) => meta)
}

export function writePage(relPath: string, content: string): void {
  if (!relPath.endsWith('.md')) throw new Error('Solo file .md sono consentiti')
  const full = path.resolve(WIKI_DIR, relPath)
  if (!full.startsWith(WIKI_DIR + path.sep)) throw new Error('Path fuori dalla wiki directory')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

export function appendLog(entry: string): void {
  const logPath = path.join(WIKI_DIR, 'log.md')
  fs.appendFileSync(logPath, '\n' + entry + '\n', 'utf-8')
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

export function getGraph(): Record<string, string[]> {
  const graph: Record<string, string[]> = {}
  for (const p of getAllPages()) graph[p.slug] = p.links
  return graph
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
