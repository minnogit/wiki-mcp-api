import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { frontmatter, makeService, writeTree } from './helpers'

// Due wiki nello stesso processo, con la stessa pagina e contenuti diversi.
const roots: string[] = []

function makeWiki(name: string, files: Record<string, string>, raw: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wiki-mcp-${name}-`))
  roots.push(root)
  const wikiDir = path.join(root, 'wiki')
  const rawDir = path.join(root, 'raw')
  fs.mkdirSync(wikiDir, { recursive: true })
  fs.mkdirSync(rawDir, { recursive: true })
  writeTree(wikiDir, files)
  writeTree(rawDir, raw)
  return { svc: makeService(wikiDir, rawDir, { name }), wikiDir, rawDir, root }
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

describe('isolamento tra wiki', () => {
  it('la stessa pagina ha contenuti diversi in ciascuna wiki', async () => {
    const a = makeWiki('a', { 'x.md': frontmatter() + '# Titolo A\n\nTesto alfa.' })
    const b = makeWiki('b', { 'x.md': frontmatter() + '# Titolo B\n\nTesto beta.' })
    expect((await a.svc.getPage('x'))?.title).toBe('Titolo A')
    expect((await b.svc.getPage('x'))?.title).toBe('Titolo B')
    expect((await a.svc.searchPages({ q: 'beta' })).length).toBe(0)
    expect((await b.svc.searchPages({ q: 'beta' })).length).toBe(1)
  })

  it('la cache di parsing non è condivisa: modificare una wiki non sporca l altra', async () => {
    const a = makeWiki('a', { 'x.md': frontmatter() + '# Uno' })
    const b = makeWiki('b', { 'x.md': frontmatter() + '# Uno' })
    // scalda entrambe le cache
    await a.svc.getAllPages()
    await b.svc.getAllPages()
    // stesso percorso relativo, contenuto di lunghezza e mtime potenzialmente uguali
    const file = path.join(a.wikiDir, 'x.md')
    fs.writeFileSync(file, frontmatter() + '# Due')
    const stat = fs.statSync(path.join(b.wikiDir, 'x.md'))
    fs.utimesSync(file, stat.atime, stat.mtime)
    expect((await a.svc.getPage('x'))?.title).toBe('Due')
    expect((await b.svc.getPage('x'))?.title).toBe('Uno')
  })

  it('scrivere in una wiki non tocca l altra (pagine, log, elenco)', async () => {
    const a = makeWiki('a', {})
    const b = makeWiki('b', {})
    await a.svc.writePage('nuova.md', frontmatter() + '# Nuova')
    await a.svc.appendLog('## [2026-01-01] ingest | prova')
    expect((await a.svc.getAllPages()).map((p) => p.slug).sort()).toEqual(['log', 'nuova'])
    expect(await b.svc.getAllPages()).toEqual([])
    expect(fs.existsSync(path.join(b.wikiDir, 'nuova.md'))).toBe(false)
    expect(fs.existsSync(path.join(b.wikiDir, 'log.md'))).toBe(false)
  })

  it('sorgenti, checksum, grafo e stato sono per wiki', async () => {
    const a = makeWiki('a', { 'p.md': frontmatter() + '# P\n\n[[q]]' }, { 's.txt': 'raw di a' })
    const b = makeWiki('b', { 'p.md': frontmatter() + '# P' }, { 's.txt': 'raw di b' })
    expect(await a.svc.readRaw('s.txt')).toBe('raw di a')
    expect(await b.svc.readRaw('s.txt')).toBe('raw di b')
    expect(await a.svc.fileChecksum('s.txt')).not.toBe(await b.svc.fileChecksum('s.txt'))
    expect((await a.svc.getGraph()).forward.p).toEqual(['q'])
    expect((await b.svc.getGraph()).forward.p).toEqual([])
    expect((await a.svc.getStatus()).totalPages).toBe(1)
  })

  it('il traversal da una wiki verso un altra è impossibile', async () => {
    const a = makeWiki('a', {})
    const b = makeWiki('b', { 'segreto.md': frontmatter() + '# Segreto B' }, { 'r.txt': 'raw b' })
    const rel = (from: string, to: string) => path.relative(from, to)

    // pagine: lettura e scrittura
    expect(await a.svc.getPage(rel(a.wikiDir, path.join(b.wikiDir, 'segreto')))).toBeNull()
    await expect(
      a.svc.writePage(rel(a.wikiDir, path.join(b.wikiDir, 'x.md')), frontmatter() + '# X'),
    ).rejects.toThrow('fuori dalla wiki')
    expect(fs.existsSync(path.join(b.wikiDir, 'x.md'))).toBe(false)

    // sorgenti e checksum
    await expect(a.svc.readRaw(rel(a.rawDir, path.join(b.rawDir, 'r.txt')))).rejects.toThrow(
      'non valido',
    )
    await expect(a.svc.readRaw(path.join(b.rawDir, 'r.txt'))).rejects.toThrow('non valido')
    await expect(
      a.svc.fileChecksum(rel(a.wikiDir, path.join(b.wikiDir, 'segreto.md'))),
    ).rejects.toThrow()
    await expect(a.svc.rawDiff(rel(a.rawDir, path.join(b.rawDir, 'r.txt')))).rejects.toThrow(
      'non valido',
    )
  })

  it('una cartella con prefisso comune (wiki vs wiki2) non è raggiungibile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-prefix-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'wiki'))
    fs.mkdirSync(path.join(root, 'wiki2'))
    fs.writeFileSync(path.join(root, 'wiki2', 'p.md'), frontmatter() + '# P2')
    const svc = makeService(path.join(root, 'wiki'), undefined)
    expect(await svc.getPage('../wiki2/p')).toBeNull()
  })

  it('i fusi orari sono per wiki', async () => {
    const mk = (name: string, tz: string) => {
      const w = makeWiki(name, { 'm.md': '# senza frontmatter' })
      // 2025-06-10 23:30 UTC: già l'11 a Tokyo, ancora il 10 a Los Angeles
      const t = new Date('2025-06-10T23:30:00Z')
      fs.utimesSync(path.join(w.wikiDir, 'm.md'), t, t)
      return makeService(w.wikiDir, undefined, { name, tz })
    }
    expect((await mk('tokyo', 'Asia/Tokyo').getStatus()).lastUpdated).toBe('2025-06-11')
    expect((await mk('la', 'America/Los_Angeles').getStatus()).lastUpdated).toBe('2025-06-10')
  })
})

describe('wiki senza rawDir', () => {
  it('le funzioni sulle sorgenti falliscono con un errore chiaro, il checksum guarda solo wiki/', async () => {
    const w = makeWiki('solo-pagine', { 'p.md': frontmatter() + '# P' })
    const svc = makeService(w.wikiDir, undefined, { name: 'solo-pagine' })
    await expect(svc.listRaw()).rejects.toThrow('Sorgenti raw non configurate')
    await expect(svc.readRaw('a.txt')).rejects.toThrow('Sorgenti raw non configurate')
    await expect(svc.rawDiff('a.txt')).rejects.toThrow('Sorgenti raw non configurate')
    expect(await svc.fileChecksum('p.md')).toMatch(/^[0-9a-f]{12}$/)
    await expect(svc.fileChecksum('a.txt')).rejects.toThrow('File non trovato')
  })
})
