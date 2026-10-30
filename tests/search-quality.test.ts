import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, frontmatter, setupService } from './helpers'

let fixture: Awaited<ReturnType<typeof setupService>> | null = null

function init(files: Record<string, string>) {
  fixture = setupService(files)
  return fixture.svc
}

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

const paths = (res: { path: string }[]): string[] => res.map((r) => r.path)

describe('searchPages: normalizzazione', () => {
  it('ignora accenti e maiuscole in entrambi i versi', async () => {
    const svc = init({
      'a.md': frontmatter() + '# A\n\nSpiegato perché serve.',
      'b.md': frontmatter() + '# B\n\nIl perche non è chiaro.',
      'c.md': frontmatter() + '# C\n\nNiente.',
    })
    for (const q of ['perché', 'perche', 'PERCHÉ']) {
      expect(paths(await svc.searchPages({ q })).sort()).toEqual(['a.md', 'b.md'])
    }
  })

  it('trova la parola dopo l’apostrofo e lo snippet la mostra', async () => {
    const svc = init({ 'a.md': frontmatter() + "# A\n\nVedi l’articolo 21 e dell'obbligo." })
    const res = await svc.searchPages({ q: 'articolo' })
    expect(paths(res)).toEqual(['a.md'])
    expect(res[0].snippet).toContain('articolo 21')
    expect(paths(await svc.searchPages({ q: 'obbligo' }))).toEqual(['a.md'])
  })
})

describe('searchPages: stemming leggero', () => {
  it('fa incontrare singolare/plurale e maschile/femminile', async () => {
    const svc = init({
      'a.md': frontmatter() + '# Fattura elettronica\n\nTesto.',
      'b.md': frontmatter() + '# B\n\nLe banche e il negozio.',
      'c.md': frontmatter() + '# C\n\nNiente.',
    })
    expect(paths(await svc.searchPages({ q: 'fatture' }))).toEqual(['a.md'])
    expect(paths(await svc.searchPages({ q: 'banca' }))).toEqual(['b.md'])
    expect(paths(await svc.searchPages({ q: 'negozi' }))).toEqual(['b.md'])
  })
})

describe('searchPages: ranking', () => {
  it('ripetere un termine nel corpo non batte titolo e tag', async () => {
    const svc = init({
      'titolo.md': frontmatter({ tags: ['fattura'] }) + '# Fattura\n\nTesto.',
      'ripetuta.md': frontmatter() + '# Altro\n\n' + 'fattura '.repeat(30),
    })
    expect(paths(await svc.searchPages({ q: 'fattura' }))).toEqual(['titolo.md', 'ripetuta.md'])
  })
})

describe('searchPages: frasi tra virgolette', () => {
  const files = {
    'si.md': frontmatter() + '# Si\n\nIl verbale di accertamento va notificato.',
    'no.md': frontmatter() + '# No\n\nAccertamento dopo il verbale, ordine diverso.',
  }

  it('senza virgolette matcha entrambe, con virgolette solo la frase', async () => {
    const svc = init(files)
    expect(paths(await svc.searchPages({ q: 'verbale accertamento' })).sort()).toEqual([
      'no.md',
      'si.md',
    ])
    for (const q of ['"verbale di accertamento"', '«verbale accertamento»']) {
      const res = await svc.searchPages({ q })
      expect(paths(res)).toEqual(['si.md'])
      expect(res[0].snippet).toContain('verbale di accertamento')
    }
  })

  it('combina frase e termini liberi', async () => {
    const svc = init({
      ...files,
      'si2.md': frontmatter() + '# Si2\n\nVerbale di accertamento e sanzione.',
    })
    const res = await svc.searchPages({ q: '"verbale di accertamento" sanzione' })
    expect(paths(res)).toEqual(['si2.md', 'si.md'])
  })
})

describe('searchPages: refusi lievi', () => {
  it('trova con un carattere sbagliato, mancante o in più, ma non con parole corte', async () => {
    const svc = init({
      'a.md': frontmatter() + '# A\n\nVerbale di accertamento.',
      'b.md': frontmatter() + '# B\n\nUna casa.',
    })
    expect(paths(await svc.searchPages({ q: 'accertamneto' }))).toEqual(['a.md'])
    expect(paths(await svc.searchPages({ q: 'acertamento' }))).toEqual(['a.md'])
    expect(paths(await svc.searchPages({ q: 'accertamentoo' }))).toEqual(['a.md'])
    expect(await svc.searchPages({ q: 'cosa' })).toEqual([])
  })

  it('un termine corretto per tolleranza pesa meno di uno scritto giusto', async () => {
    const svc = init({ 'a.md': frontmatter() + '# A\n\nParola accertamento qui.' })
    const [exact] = await svc.searchPages({ q: 'accertamento' })
    const [typo] = await svc.searchPages({ q: 'accertamneto' })
    expect(typo.score).toBeGreaterThan(0)
    expect(typo.score).toBeLessThan(exact.score!)
  })
})

describe('searchPages: cache dell’indice', () => {
  it('riflette le modifiche ai file (invalidazione come pageCache)', async () => {
    const svc = init({ 'a.md': frontmatter() + '# A\n\nPrimo testo.' })
    expect(await svc.searchPages({ q: 'novita' })).toEqual([])
    await svc.writePage('a.md', frontmatter() + '# A\n\nNovità importante, molto più lungo.')
    expect(paths(await svc.searchPages({ q: 'novità' }))).toEqual(['a.md'])
  })
})
