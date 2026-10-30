import { afterEach, describe, expect, it } from 'vitest'
import { runWithPrincipal, type Principal } from '../src/auth.js'
import { createLogger, log, setLogger } from '../src/log.js'
import { buildServer } from '../src/server.js'
import { createWikiService } from '../src/wiki/service.js'
import { cleanup, frontmatter, setupService, type Fixture } from './helpers'
import { SECRET_CONTENT, makeTelemetry } from './obs-helpers'

const principal = (id: string, groups: string[]): Principal => ({
  id,
  user: id,
  groups,
  wikis: '*',
  propose: [],
})
const hr = principal('anna', ['hr'])
const fuori = principal('bruno', ['it'])
const admin = principal('ada', ['admin'])

const page = (extra: string, body: string, opts: Parameters<typeof frontmatter>[0] = {}) =>
  frontmatter({ ...opts, extra }) + body

// Pagine visibili a tutti.
const VISIBILI: Record<string, string> = {
  'index.md': '# Indice\n\n- [[concetti/aperto]]\n',
  'concetti/aperto.md': page(
    '',
    '# Aperto\n\nParla di fatture, di [[segreto]] e di [[concetti/stipendi]].\n',
    { tags: ['fatture'] },
  ),
  'concetti/interno.md': page('visibilita: interna', '# Interno\n\nFatture interne, mela mela.\n', {
    tags: ['fatture'],
    aggiornato: '2026-03-01',
  }),
  'procedure/pubblica.md': page(
    'visibilita: pubblica',
    '# Pubblica\n\nProcedura sulle fatture.\n',
    {
      tipo: 'procedura',
      stato: 'stabile',
      aggiornato: '2026-04-01',
    },
  ),
}

// Riservate ad `hr` (e `admin`).
const PER_HR: Record<string, string> = {
  'concetti/stipendi.md': page(
    'visibilita: riservata\ngruppi: [hr]',
    '# Stipendi\n\nFatture e stipendi: banane banane banane, ananas.\n',
    { tipo: 'analisi', stato: 'stabile', tags: ['paghe', 'fatture'], aggiornato: '2030-01-01' },
  ),
  'segreto.md': page('visibilita: riservata\ngruppi: [hr, legal]', '# Segreto\n\nSolo hr.\n'),
  // refuso nel valore: fail-closed come riservata
  'concetti/refuso.md': page('visibilita: riservta\ngruppi: [hr]', '# Refuso\n\nFatture ananas.\n'),
}

// Riservata senza gruppi: solo admin.
const SOLO_ADMIN: Record<string, string> = {
  'analisi/solo-admin.md': page('visibilita: riservata', '# Solo admin\n\nFatture ananas.\n', {
    tipo: 'analisi',
  }),
}

const fixtures: Fixture[] = []
const make = (files: Record<string, string>) => {
  const f = setupService(files)
  fixtures.push(f)
  return f
}
afterEach(() => {
  fixtures.splice(0).forEach(cleanup)
})

const as = <T>(p: Principal | undefined, fn: () => T): T => (p ? runWithPrincipal(p, fn) : fn())

const full = () => make({ ...VISIBILI, ...PER_HR, ...SOLO_ADMIN })
// wiki «gemella»: gli stessi file, senza le pagine che il principal non dovrebbe vedere
const twinFor = (who: 'fuori' | 'hr') =>
  make(who === 'hr' ? { ...VISIBILI, ...PER_HR } : { ...VISIBILI })

describe('wikiListPages / getAllPages', () => {
  it('ognuno vede solo ciò che gli spetta', async () => {
    const { svc } = full()
    const slugs = async (p: Principal | undefined) =>
      (await as(p, () => svc.getAllPages())).map((x) => x.slug).sort()
    const pubbliche = ['concetti/aperto', 'concetti/interno', 'index', 'procedure/pubblica']
    expect(await slugs(fuori)).toEqual(pubbliche)
    expect(await slugs(hr)).toEqual(
      [...pubbliche, 'concetti/refuso', 'concetti/stipendi', 'segreto'].sort(),
    )
    const tutte = [
      ...pubbliche,
      'concetti/refuso',
      'concetti/stipendi',
      'segreto',
      'analisi/solo-admin',
    ].sort()
    expect(await slugs(admin)).toEqual(tutte)
    expect(await slugs(undefined)).toEqual(tutte) // stdio locale: fiducia piena
  })

  it('il token legacy (nessun gruppo) non vede le riservate', async () => {
    const { svc } = full()
    const legacy = principal('legacy', [])
    expect((await as(legacy, () => svc.getAllPages())).map((x) => x.slug)).not.toContain('segreto')
  })

  it('il principal si può passare esplicitamente al service', async () => {
    const { wikiDir } = full()
    const svc = createWikiService({ name: 't', wikiDir }, { principal: () => fuori })
    expect((await svc.getAllPages()).map((x) => x.slug)).not.toContain('segreto')
    const svcHr = createWikiService({ name: 't', wikiDir }, { principal: () => hr })
    expect((await svcHr.getAllPages()).map((x) => x.slug)).toContain('segreto')
  })

  it('la cache di parsing è per pagina: due principal alternati vedono ciascuno il proprio insieme', async () => {
    const { svc } = full()
    for (let i = 0; i < 3; i++) {
      expect((await as(hr, () => svc.getAllPages())).length).toBe(7)
      expect((await as(fuori, () => svc.getAllPages())).length).toBe(4)
    }
  })

  it('nel frontmatter letto compaiono visibilita e gruppi, e il refuso è segnalato', async () => {
    const { svc } = full()
    const stipendi = await as(hr, () => svc.getPage('concetti/stipendi'))
    expect(stipendi?.frontmatter).toMatchObject({ visibilita: 'riservata', gruppi: ['hr'] })
    const refuso = await as(hr, () => svc.getPage('concetti/refuso'))
    expect(refuso?.frontmatter).toMatchObject({
      visibilita: 'riservata',
      visibilitaNonValida: 'riservta',
    })
    // le pagine senza i campi non cambiano forma
    const aperto = await as(hr, () => svc.getPage('concetti/aperto'))
    expect(Object.keys(aperto!.frontmatter)).not.toContain('visibilita')
    expect(Object.keys(aperto!.frontmatter)).not.toContain('gruppi')
  })

  it('un valore sconosciuto viene segnalato nel log una volta per versione del file', async () => {
    const lines: string[] = []
    const previous = log()
    setLogger(createLogger({ format: 'json', sink: (l) => lines.push(l) }))
    try {
      const { svc } = full()
      await as(admin, () => svc.getAllPages())
      await as(admin, () => svc.getAllPages())
      const warns = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatchObject({
        level: 'warn',
        event: 'page-visibility-invalid',
        page: 'concetti/refuso.md',
        value: 'riservta',
      })
    } finally {
      setLogger(previous)
    }
  })

  it('un valore sconosciuto è fail-closed anche per chi non è nel gruppo, e `gruppi` non lista vale vuoto', async () => {
    const f = make({
      'a.md': page('visibilita: segreta', '# A\n'),
      'b.md': page('visibilita: riservata\ngruppi: hr', '# B\n'),
      'c.md': page('visibilita: ', '# C\n'),
    })
    expect((await as(hr, () => f.svc.getAllPages())).map((x) => x.slug)).toEqual([])
    expect((await as(admin, () => f.svc.getAllPages())).map((x) => x.slug).sort()).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})

describe('wikiSearch: nessuna fuga indiretta', () => {
  const QUERIES = [
    'fatture',
    'fatture stipendi',
    'ananas',
    'banane',
    'ananass', // refuso: il vocabolario nascosto non deve fornire «ananas»
    'stipendo',
    '"fatture interne"',
    'mela',
    'segreto',
    'la', // solo stopword: fallback a substring match
  ]

  it.each(QUERIES)(
    'risultati e punteggi identici a una wiki senza le pagine nascoste: %s',
    async (q) => {
      const { svc } = full()
      const twin = twinFor('fuori')
      const mine = await as(fuori, () => svc.searchPages({ q, topK: 50 }))
      const theirs = await as(fuori, () => twin.svc.searchPages({ q, topK: 50 }))
      expect(mine).toEqual(theirs) // path, score (quindi docFreq/IDF) e snippet
    },
  )

  it.each(QUERIES)('idem per il gruppo hr, che vede le sue ma non solo-admin: %s', async (q) => {
    const { svc } = full()
    const twin = twinFor('hr')
    expect(await as(hr, () => svc.searchPages({ q, topK: 50 }))).toEqual(
      await as(hr, () => twin.svc.searchPages({ q, topK: 50 })),
    )
  })

  it('i punteggi dipendono dal corpus visibile: senza le nascoste «mela» pesa di più', async () => {
    const { svc } = full()
    const [first] = await as(fuori, () => svc.searchPages({ q: 'mela' }))
    const [firstAdmin] = await as(admin, () => svc.searchPages({ q: 'mela' }))
    expect(first.score).not.toBe(firstAdmin.score)
  })

  it('i filtri tag/tipo/stato non rivelano le nascoste', async () => {
    const { svc } = full()
    expect((await as(fuori, () => svc.searchPages({ tag: 'paghe' }))).length).toBe(0)
    expect((await as(fuori, () => svc.searchPages({ tipo: 'analisi' }))).length).toBe(0)
    expect(
      (await as(fuori, () => svc.searchPages({ stato: 'stabile' }))).map((p) => p.slug),
    ).toEqual(['procedure/pubblica'])
    expect((await as(hr, () => svc.searchPages({ tag: 'paghe' }))).map((p) => p.slug)).toEqual([
      'concetti/stipendi',
    ])
  })

  it('lo snippet viene solo da pagine visibili', async () => {
    const { svc } = full()
    const res = await as(fuori, () => svc.searchPages({ q: 'banane ananas' }))
    expect(res).toEqual([])
    expect(JSON.stringify(await as(fuori, () => svc.searchPages({ q: 'fatture' })))).not.toContain(
      'banane',
    )
  })
})

describe('wikiGraph: come se le nascoste non esistessero', () => {
  it('per chi è fuori, grafo identico a quello della wiki senza le nascoste', async () => {
    const { svc } = full()
    const twin = twinFor('fuori')
    expect(await as(fuori, () => svc.getGraph())).toEqual(
      await as(fuori, () => twin.svc.getGraph()),
    )
  })

  it('per hr, grafo identico a quello della wiki senza la sola-admin', async () => {
    const { svc } = full()
    const twin = twinFor('hr')
    expect(await as(hr, () => svc.getGraph())).toEqual(await as(hr, () => twin.svc.getGraph()))
  })

  it('nessuna pagina nascosta è tra i nodi di forward né tra gli orfani; i suoi link in uscita non compaiono', async () => {
    const { svc } = full()
    const g = await as(fuori, () => svc.getGraph())
    const hidden = ['segreto', 'concetti/stipendi', 'concetti/refuso', 'analisi/solo-admin']
    for (const h of hidden) {
      expect(Object.keys(g.forward)).not.toContain(h)
      expect(g.orphans).not.toContain(h)
    }
    // nessun arco parte da una pagina nascosta
    for (const h of hidden) expect(Object.values(g.reverse).flat()).not.toContain(h)
    // i link da una pagina visibile a una nascosta restano visti come link a pagina inesistente:
    // identici a quelli verso uno slug che non esiste (vedi test gemello sopra)
    expect(g.forward['concetti/aperto']).toEqual(['segreto', 'concetti/stipendi'])
  })

  it('con le nascoste, per admin il grafo è completo', async () => {
    const { svc } = full()
    const g = await as(admin, () => svc.getGraph())
    expect(Object.keys(g.forward)).toContain('segreto')
    expect(g.reverse['segreto']).toEqual(['concetti/aperto'])
  })
})

describe('wikiStatus: conteggi e date solo sul visibile', () => {
  it('uguale a quello della wiki senza le nascoste (totali, byTipo, byStato, lastUpdated)', async () => {
    const { svc } = full()
    const twin = twinFor('fuori')
    const { source: _a, ...mine } = await as(fuori, () => svc.getStatus())
    const { source: _b, ...theirs } = await as(fuori, () => twin.svc.getStatus())
    expect(mine).toEqual(theirs)
    expect(mine.totalPages).toBe(4)
    expect(mine.lastUpdated).not.toBe('2030-01-01') // la data della pagina nascosta non trapela
  })

  it('per hr e per admin i conteggi crescono', async () => {
    const { svc } = full()
    expect((await as(hr, () => svc.getStatus())).totalPages).toBe(7)
    const adminStatus = await as(admin, () => svc.getStatus())
    expect(adminStatus.totalPages).toBe(8)
    expect(adminStatus.lastUpdated).toBe('2030-01-01')
  })
})

describe('wikiReadPage: negata = inesistente, ma l audit distingue', () => {
  type Exec = (input: unknown, ctx: unknown) => Promise<unknown>
  function setup() {
    const f = full()
    const t = makeTelemetry()
    const server = buildServer(f.svc, t.tel)
    const run = (p: Principal | undefined, name: string, input: unknown = {}) =>
      as(p, () => (server.tools() as Record<string, { execute: Exec }>)[name].execute(input, {}))
    return { ...t, run, f }
  }

  it('la risposta per una pagina nascosta è byte-per-byte quella di una wiki dove non esiste', async () => {
    const { run } = setup()
    const twin = twinFor('fuori')
    const twinTel = makeTelemetry()
    const twinServer = buildServer(twin.svc, twinTel.tel)
    for (const slug of ['concetti/stipendi', 'segreto', 'analisi/solo-admin', 'concetti/refuso']) {
      const negata = await run(fuori, 'wikiReadPage', { slug })
      const inesistente = await as(fuori, () =>
        (twinServer.tools() as Record<string, { execute: Exec }>).wikiReadPage.execute(
          { slug },
          {},
        ),
      )
      expect(JSON.stringify(negata)).toBe(JSON.stringify(inesistente))
      expect(negata).toEqual({ error: `Pagina non trovata: ${slug}` })
    }
  })

  it('anche con estensione .md e per admin la pagina c è', async () => {
    const { run } = setup()
    expect(await run(fuori, 'wikiReadPage', { slug: 'segreto.md' })).toEqual({
      error: 'Pagina non trovata: segreto.md',
    })
    expect(await run(admin, 'wikiReadPage', { slug: 'segreto.md' })).toMatchObject({
      slug: 'segreto',
    })
    expect(await run(hr, 'wikiReadPage', { slug: 'segreto' })).toMatchObject({ slug: 'segreto' })
    expect(await run(undefined, 'wikiReadPage', { slug: 'analisi/solo-admin' })).toMatchObject({
      slug: 'analisi/solo-admin',
    })
  })

  it('evento denied solo per pagina esistente e negata; l inesistente è un normale errore', async () => {
    const { run, events } = setup()
    await run(fuori, 'wikiReadPage', { slug: 'concetti/stipendi' })
    await run(fuori, 'wikiReadPage', { slug: 'non/esiste' })
    await run(fuori, 'wikiReadPage', { slug: 'concetti/refuso' })
    await run(fuori, 'wikiReadPage', { slug: 'concetti/aperto' })
    await run(admin, 'wikiReadPage', { slug: 'concetti/stipendi' })
    const [denied, notFound, invalid, ok, adminOk] = events('audit')
    expect(denied).toMatchObject({
      tool: 'wikiReadPage',
      outcome: 'denied',
      reason: 'visibility',
      principal: { id: 'bruno', user: 'bruno' },
      args: { slug: 'concetti/stipendi' },
    })
    expect(denied.error).toBeUndefined()
    expect(notFound).toMatchObject({ outcome: 'error', error: 'Pagina non trovata: non/esiste' })
    expect(notFound.reason).toBeUndefined()
    expect(invalid).toMatchObject({ outcome: 'denied', reason: 'visibility-invalid' })
    expect(ok.outcome).toBe('ok')
    expect(adminOk.outcome).toBe('ok')
  })

  it('search, list, graph e status non emettono denied (le nascoste semplicemente non ci sono)', async () => {
    const { run, events } = setup()
    await run(fuori, 'wikiSearch', { q: 'fatture' })
    await run(fuori, 'wikiListPages')
    await run(fuori, 'wikiGraph')
    await run(fuori, 'wikiStatus')
    expect(events('audit').map((e) => e.outcome)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('il motivo denied è nel vocabolario chiuso e l audit non contiene contenuti né gruppi', async () => {
    const { run, lines } = setup()
    await run(fuori, 'wikiReadPage', { slug: 'concetti/stipendi' })
    const text = lines.join('\n')
    expect(text).not.toContain('banane')
    expect(text).not.toContain(SECRET_CONTENT)
    expect(text).not.toContain('"hr"')
  })

  it('wikiListPages per un fuori non elenca le nascoste, nemmeno con categoria', async () => {
    const { run } = setup()
    const all = (await run(fuori, 'wikiListPages')) as { slug: string }[]
    expect(all.map((p) => p.slug)).not.toContain('concetti/stipendi')
    const cat = (await run(fuori, 'wikiListPages', { categoria: 'concetti' })) as { slug: string }[]
    expect(cat.map((p) => p.slug).sort()).toEqual(['concetti/aperto', 'concetti/interno'])
    const catHr = (await run(hr, 'wikiListPages', { categoria: 'concetti' })) as { slug: string }[]
    expect(catHr.map((p) => p.slug)).toContain('concetti/stipendi')
  })

  it('wikiChecksum non rivela esistenza né hash di una pagina nascosta', async () => {
    const { run } = setup()
    const negata = await run(fuori, 'wikiChecksum', { path: 'concetti/stipendi.md' })
    expect(negata).toEqual({ error: 'File non trovato: concetti/stipendi.md' })
    const mancante = await run(fuori, 'wikiChecksum', { path: 'non/esiste.md' })
    expect(mancante).toEqual({ error: 'File non trovato: non/esiste.md' })
    expect(await run(hr, 'wikiChecksum', { path: 'concetti/stipendi.md' })).toMatchObject({
      checksum: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
    })
  })

  it('i file riservati di radice sono visibili, salvo che dichiarino una visibilita', async () => {
    const f = make({
      ...VISIBILI,
      'overview.md': page('visibilita: riservata\ngruppi: [hr]', '# Panoramica\n'),
    })
    const slugs = async (p: Principal) =>
      (await as(p, () => f.svc.getAllPages())).map((x) => x.slug)
    expect(await slugs(fuori)).toContain('index')
    expect(await slugs(fuori)).not.toContain('overview')
    expect(await slugs(hr)).toContain('overview')
  })
})

describe('scrittura: validazione dei campi', () => {
  const ok = (extra: string) => page(extra, '# Nuova\n')

  it('accetta visibilita valide e gruppi', async () => {
    const { svc } = make({})
    for (const extra of [
      '',
      'visibilita: pubblica',
      'visibilita: interna',
      'visibilita: riservata',
      'visibilita: riservata\ngruppi: [hr, legal]',
    ])
      await expect(svc.writePage('concetti/n.md', ok(extra))).resolves.toEqual([])
  })

  it('rifiuta valori non validi con un messaggio descrittivo', async () => {
    const { svc } = make({})
    await expect(svc.writePage('n.md', ok('visibilita: riservta'))).rejects.toThrow(
      /Frontmatter non valido in n\.md: visibilita deve essere pubblica\|interna\|riservata/,
    )
    await expect(svc.writePage('n.md', ok('visibilita: riservata\ngruppi: hr'))).rejects.toThrow(
      /gruppi deve essere una lista/,
    )
    await expect(svc.writePage('n.md', ok('visibilita: riservata\ngruppi: [""]'))).rejects.toThrow(
      /gruppi\.0 non deve contenere nomi vuoti/,
    )
  })

  it('avvisa (senza bloccare) se gruppi è su una pagina non riservata', async () => {
    const { svc } = make({})
    expect(await svc.writePage('n.md', ok('visibilita: pubblica\ngruppi: [hr]'))).toEqual([
      'gruppi ignorato: ha effetto solo con visibilita: riservata (in n.md)',
    ])
    expect(await svc.writePage('m.md', ok('gruppi: [hr]'))).toHaveLength(1)
  })

  it('i file riservati di radice restano esenti, ma i due campi, se presenti, sono validati', async () => {
    const { svc } = make({})
    await expect(svc.writePage('index.md', '# Indice\n')).resolves.toEqual([])
    await expect(
      svc.writePage('index.md', '---\nvisibilita: riservata\ngruppi: [hr]\n---\n# Indice\n'),
    ).resolves.toEqual([])
    await expect(
      svc.writePage('index.md', '---\nvisibilita: riservta\n---\n# Indice\n'),
    ).rejects.toThrow('Frontmatter non valido')
  })

  it('wikiWritePage riporta gli avvisi e le pagine scritte sono poi filtrate', async () => {
    const f = make({})
    const server = buildServer(f.svc, makeTelemetry().tel)
    const res = await (
      server.tools() as Record<string, { execute: (i: unknown, c: unknown) => Promise<unknown> }>
    ).wikiWritePage.execute(
      { path: 'x.md', content: ok('visibilita: riservata\ngruppi: [hr]') },
      {},
    )
    expect(res).toEqual({ success: true, path: 'x' + '.md' })
    expect((await as(fuori, () => f.svc.getAllPages())).length).toBe(0)
    expect((await as(hr, () => f.svc.getAllPages())).length).toBe(1)
  })
})
