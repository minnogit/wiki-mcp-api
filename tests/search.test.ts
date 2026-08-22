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

describe('searchPages', () => {
  it('ordina per rilevanza: titolo > tag > contenuto', async () => {
    const svc = await init({
      'titolo.md': frontmatter() + '# Parolachiave in titolo\n\nTesto senza termini.',
      'tag.md': frontmatter({ tags: ['parolachiave'] }) + '# Titolo neutro\n\nContenuto generico.',
      'contenuto.md': frontmatter() + '# Titolo neutro\n\nParola parolachiave nel testo.',
      'assente.md': frontmatter() + '# Titolo neutro\n\nNulla qui.',
    })
    const res = await svc.searchPages({ q: 'parolachiave' })
    expect(res.map((r) => r.path)).toEqual(['titolo.md', 'tag.md', 'contenuto.md'])
    expect(res[0].score).toBeGreaterThan(res[1].score!)
    expect(res[1].score).toBeGreaterThan(res[2].score!)
  })

  it('filtra per tag case-insensitive, tipo e stato', async () => {
    const svc = await init({
      'a.md': frontmatter({ tags: ['Verbali'] }) + '# A',
      'b.md': frontmatter({ tags: ['altro'], tipo: 'analisi' }) + '# B',
      'c.md': frontmatter({ tags: ['test'], stato: 'stabile' }) + '# C',
    })
    expect((await svc.searchPages({ tag: 'verbali' })).map((r) => r.path)).toEqual(['a.md'])
    expect((await svc.searchPages({ tipo: 'analisi' })).map((r) => r.path)).toEqual(['b.md'])
    expect((await svc.searchPages({ stato: 'stabile' })).map((r) => r.path)).toEqual(['c.md'])
  })

  it('senza q non ordina ma rispetta topK', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`p${i}.md`, frontmatter() + `# P${i}`]),
    )
    const svc = await init(files)
    expect(await svc.searchPages({})).toHaveLength(5)
    expect(await svc.searchPages({ topK: 2 })).toHaveLength(2)
  })

  it('query di sole stopwords: fallback substring match con snippet', async () => {
    const svc = await init({
      'x.md': frontmatter() + '# X\n\nLa parola RARA-TERM qui.',
      'y.md': frontmatter() + '# Y\n\nNiente.',
    })
    const res = await svc.searchPages({ q: 'la' })
    expect(res.map((r) => r.path)).toEqual(['x.md'])
    expect(res[0].snippet).toContain('RARA-TERM')
  })

  it('non espone content né links nei risultati', async () => {
    const svc = await init({ 'solo.md': frontmatter() + '# S\n\nVedi [[altra]] e termine.' })
    const [only] = await svc.searchPages({ q: 'termine' })
    expect(only).not.toHaveProperty('content')
    expect(only).not.toHaveProperty('links')
    expect(only.snippet).toBeDefined()
  })
})
