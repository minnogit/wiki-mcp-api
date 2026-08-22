import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, frontmatter, setupService } from './helpers'

let fixture: Awaited<ReturnType<typeof setupService>> | null = null

async function init(files: Record<string, string>) {
  fixture = await setupService(files)
  return fixture.svc
}

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

describe('getGraph', () => {
  it('costruisce forward, reverse e orphans', async () => {
    const svc = await init({
      // link con label [[slug|label]] e dedup dei ripetuti
      'a.md': frontmatter() + '# A\n\nVedi [[b]] e ancora [[b|seconda volta]] e [[c]].',
      'b.md': frontmatter() + '# B',
      'index.md': '# Indice senza frontmatter',
    })
    const g = await svc.getGraph()
    expect(g.forward['a']).toEqual(['b', 'c'])
    expect(g.forward['b']).toEqual([])
    expect(g.reverse['a']).toEqual([]) // ogni pagina nota è inizializzata; nessuno linka a
    expect(g.reverse['b']).toEqual(['a'])
    expect(g.orphans).toEqual(['a']) // a non riceve alcun link; index escluso perché riservato
  })

  it('i link rotti compaiono in reverse ma non in forward', async () => {
    const svc = await init({ 'x.md': frontmatter() + '# X\n\nPunta a [[inesistente]].' })
    const g = await svc.getGraph()
    expect(g.forward['inesistente']).toBeUndefined()
    expect(g.reverse['inesistente']).toEqual(['x'])
  })
})

describe('getStatus', () => {
  it('conteggia per tipo e stato, incluse le categorie di default', async () => {
    const svc = await init({
      'a.md': frontmatter({ tipo: 'concetto', stato: 'bozza' }) + '# A',
      'b.md': frontmatter({ tipo: 'analisi', stato: 'stabile' }) + '# B',
      'log.md': '# log senza frontmatter',
    })
    const s = await svc.getStatus()
    expect(s.totalPages).toBe(3)
    expect(s.byTipo).toEqual({ concetto: 1, analisi: 1, 'senza-tipo': 1 })
    expect(s.byStato).toEqual({ bozza: 1, stabile: 1, 'senza-stato': 1 })
  })

  it('lastUpdated usa la data semantica più recente, non il mtime', async ({ }) => {
    const wikiDir = (await init({
      'vecchia.md': frontmatter({ aggiornato: '2026-01-01' }) + '# V',
      'recente.md': frontmatter({ aggiornato: '2026-08-22' }) + '# R',
    })) && fixture!.wikiDir
    // mtime antichi: se lastUpdated fosse mtime-based, sarebbe 2025
    for (const f of ['vecchia.md', 'recente.md']) {
      fs.utimesSync(path.join(wikiDir, f), new Date('2025-03-15T00:30:00Z'), new Date('2025-03-15T00:30:00Z'))
    }
    expect((await fixture!.svc.getStatus()).lastUpdated).toBe('2026-08-22')
  })

  it('senza date valide nel frontmatter ricade sul mtime', async ({ }) => {
    process.env.WIKI_TZ = 'UTC'
    const svc = await init({
      'solo-mtime.md': '# Solo titolo, niente frontmatter valido',
    })
    const wikiDir = fixture!.wikiDir
    fs.utimesSync(path.join(wikiDir, 'solo-mtime.md'), new Date('2025-06-10T12:00:00Z'), new Date('2025-06-10T12:00:00Z'))
    expect((await svc.getStatus()).lastUpdated).toBe('2025-06-10')
    delete process.env.WIKI_TZ
  })
})
