import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, frontmatter, setupService } from './helpers'

let fixture: Awaited<ReturnType<typeof setupService>> | null = null

async function init(files: Record<string, string> = {}) {
  fixture = await setupService(files)
  return { svc: fixture.svc, wikiDir: fixture.wikiDir }
}

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

describe('writePage', () => {
  it('scrive una pagina valida e crea le sottocartelle', async ({ }) => {
    const { svc, wikiDir } = await init()
    await svc.writePage('concetti/nuova.md', frontmatter() + '# Nuova')
    expect(fs.readFileSync(path.join(wikiDir, 'concetti/nuova.md'), 'utf-8')).toContain('# Nuova')
  })

  it('rifiuta frontmatter non valido con errore descrittivo', async () => {
    const { svc } = await init()
    const cases: Array<[string, string, string]> = [
      ['tipo sbagliato', '---\ntipo: inventato\ntags:\n  - t\nfonti: []\naggiornato: "2026-08-22"\nstato: bozza\n---\n', 'tipo'],
      ['tag mancante', '---\ntipo: concetto\ntags: []\nfonti: []\naggiornato: "2026-08-22"\nstato: bozza\n---\n', 'tags'],
      ['data malformata', '---\ntipo: concetto\ntags:\n  - t\nfonti: []\naggiornato: "22-08-2026"\nstato: bozza\n---\n', 'aggiornato'],
      ['stato non previsto', '---\ntipo: concetto\ntags:\n  - t\nfonti: []\naggiornato: "2026-08-22"\nstato: bozza2\n---\n', 'stato'],
      ['senza frontmatter', '# Solo testo', 'tipo'],
    ]
    for (const [label, content, expectedIn] of cases) {
      const err = await svc.writePage('bad.md', content).catch((e: Error) => e.message)
      expect(err, label).toContain('Frontmatter non valido in bad.md')
      expect(err, label).toContain(expectedIn)
    }
  })

  it('i file riservati della radice sono esenti dal frontmatter', async () => {
    const { svc } = await init()
    for (const name of ['index.md', 'log.md', 'sources.md', 'overview.md']) {
      await expect(svc.writePage(name, '# libero')).resolves.toBeUndefined()
    }
    await expect(svc.writePage('sottocartella/log.md', '# libero')).rejects.toThrow('Frontmatter non valido')
  })

  it('rifiuta file non .md e path traversal', async () => {
    const { svc, wikiDir } = await init()
    await expect(svc.writePage('pagina.txt', frontmatter())).rejects.toThrow('.md')
    await expect(svc.writePage('../fuori.md', frontmatter())).rejects.toThrow('fuori dalla wiki')
    await expect(svc.writePage('sub/../../fuori.md', frontmatter())).rejects.toThrow('fuori dalla wiki')
    expect(fs.existsSync(path.join(wikiDir, '../fuori.md'))).toBe(false)
  })
})

describe('cache di parsing', () => {
  it('una pagina scritta via writePage è subito visibile alla ricerca', async () => {
    const { svc } = await init({ 'esistente.md': frontmatter() + '# Esistente' })
    expect(await svc.searchPages({ q: 'terminenuovo123' })).toHaveLength(0)
    await svc.writePage('nuova.md', frontmatter() + '# N\n\nContiene terminenuovo123.')
    const res = await svc.searchPages({ q: 'terminenuovo123' })
    expect(res.map((p) => p.path)).toEqual(['nuova.md'])
  })

  it('un edit esterno invalida la voce di cache', async ({ }) => {
    const { svc, wikiDir } = await init({ 'editata.md': frontmatter() + '# E\n\nVersione uno.' })
    expect((await svc.getPage('editata'))?.content).toContain('Versione uno')
    // size diversa per non affidarsi alla sola granularità dell'mtime
    fs.writeFileSync(path.join(wikiDir, 'editata.md'), frontmatter() + '# E\n\nVersione due più lunga.')
    expect((await svc.getPage('editata'))?.content).toContain('Versione due')
  })

  it('una pagina cancellata esternamente sparisce dai risultati', async ({ }) => {
    const { svc, wikiDir } = await init({ 'vittima.md': frontmatter() + '# V', 'resta.md': frontmatter() + '# R' })
    fs.rmSync(path.join(wikiDir, 'vittima.md'))
    expect((await svc.getAllPages()).map((p) => p.slug)).toEqual(['resta'])
    expect(await svc.getPage('vittima')).toBeNull()
  })
})
