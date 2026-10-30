import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_PRINCIPAL } from '../src/auth.js'
import {
  PATH_DENIED_MESSAGE,
  pathProblem,
  branchName,
  type ProposeResult,
} from '../src/proposals.js'
import { VALID, WIKI_FILES, makeProposalEnv, principal, type ProposalEnv } from './proposal-helpers'

let env: ProposalEnv
afterEach(async () => {
  await env?.close()
})

const alice = principal('alice-1', ['hr'])
const admin = principal('ada-1', ['admin'])
const OK = { path: 'concetti/nuova.md', content: VALID() }
const failure = (r: ProposeResult): string => {
  expect('error' in r, JSON.stringify(r)).toBe(true)
  return (r as { error: string }).error
}
const last = (e: ProposalEnv) => e.events('audit').at(-1)!

describe('wikiProposePage: creazione e modifica', () => {
  it('crea branch, commit del bot e PR; non tocca main né il clone servito; non fa merge', async () => {
    env = await makeProposalEnv()
    const r = await env.run(alice, { ...OK, rationale: 'serve una pagina', title: 'Nuova pagina' })
    expect(r).toMatchObject({ action: 'create', prNumber: 1 })
    const ok = r as { prUrl: string; branch: string }
    expect(ok.prUrl).toBe(`https://github.example/${env.fake.repo}/pull/1`)
    expect(ok.branch).toMatch(/^proposta\/alice-concetti-nuova-\d{8}T\d{6}Z-[0-9a-f]{4}$/)
    // branch con il file, main intatto
    expect(env.fake.branches.get(ok.branch)!.get('wiki/concetti/nuova.md')!.content).toBe(
      OK.content,
    )
    expect(env.fake.branches.get('main')!.has('wiki/concetti/nuova.md')).toBe(false)
    // commit del bot con il trailer
    expect(env.fake.commits).toHaveLength(1)
    expect(env.fake.commits[0].author).toEqual({
      name: 'wiki-mcp-bot',
      email: 'wiki-mcp-bot@users.noreply.github.com',
    })
    expect(env.fake.commits[0].committer).toEqual(env.fake.commits[0].author)
    expect(env.fake.commits[0].message.split('\n').at(-1)).toBe('Proposed-by: alice (alice-1)')
    // PR verso la base, con proponente nel corpo
    expect(env.fake.pulls[0]).toMatchObject({ base: 'main', head: ok.branch })
    expect(env.fake.pulls[0].title).toBe('[test] Nuova pagina')
    expect(env.fake.pulls[0].body).toContain('Proposed-by: alice (alice-1)')
    expect(env.fake.pulls[0].body).toContain('> serve una pagina')
    // nessuna scrittura locale, nessuna chiamata di merge
    expect(fs.existsSync(path.join(env.fx.wikiDir, 'concetti/nuova.md'))).toBe(false)
    expect(env.fake.requests.some((q) => /merge/.test(q.path))).toBe(false)
  })

  it('una modifica usa lo SHA del blob esistente e risulta action update', async () => {
    env = await makeProposalEnv()
    const r = await env.run(alice, { path: 'concetti/aperta.md', content: VALID() })
    expect(r).toMatchObject({ action: 'update' })
    const put = env.fake.requests.find((q) => q.method === 'PUT')!
    expect((put.body as { sha?: string }).sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('contenuto identico alla versione attuale: niente PR vuota', async () => {
    const content = VALID()
    env = await makeProposalEnv({ seed: { 'wiki/concetti/aperta.md': content } })
    const r = await env.run(alice, { path: 'concetti/aperta.md', content })
    expect(failure(r)).toMatch(/identico/)
    expect(env.fake.pulls).toHaveLength(0)
    expect(env.fake.branches.size).toBe(1)
  })

  it('pathPrefix e baseBranch configurabili; etichette applicate; etichette mancate non annullano la PR', async () => {
    env = await makeProposalEnv({
      overrides: { pathPrefix: 'docs/wiki', baseBranch: 'dev', labels: ['wiki', 'proposta'] },
    })
    // il branch base di prova è `dev`
    env.fake.branches.set('dev', new Map())
    env.fake.branchCommit.set('dev', 'a'.repeat(40))
    const r = await env.run(alice, OK)
    expect(r).toMatchObject({ action: 'create' })
    expect(env.fake.pulls[0]).toMatchObject({ base: 'dev', labels: ['wiki', 'proposta'] })
    expect([...env.fake.branches.get((r as { branch: string }).branch)!.keys()]).toEqual([
      'docs/wiki/concetti/nuova.md',
    ])

    env.fake.failNext('POST', /\/labels$/, 500)
    const r2 = await env.run(alice, { path: 'concetti/due.md', content: VALID() })
    expect(r2).toMatchObject({ action: 'create' })
    expect(env.events('proposal-labels-failed')).toHaveLength(1)
  })
})

describe('wikiProposePage: permesso propose', () => {
  it.each([
    ['senza propose', principal('a-1', [], { propose: [] })],
    ['propose su un altra wiki', principal('a-1', [], { propose: ['altra'] })],
    ['token legacy', LEGACY_PRINCIPAL],
    ['wiki non abilitata al token', principal('a-1', [], { wikis: ['altra'], propose: ['test'] })],
    ['nessun principal', undefined],
  ])('%s: negato, senza toccare GitHub', async (_n, p) => {
    env = await makeProposalEnv()
    const r = await env.run(p, OK)
    expect(failure(r)).toMatch(/permesso/)
    expect(env.fake.requests).toHaveLength(0)
    expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'propose-not-allowed' })
  })

  it('propose "*" e propose elencato funzionano', async () => {
    env = await makeProposalEnv()
    expect(await env.run(principal('a-1', [], { propose: '*' }), OK)).toMatchObject({
      action: 'create',
    })
    expect(
      await env.run(principal('b-1', [], { propose: ['test'] }), { ...OK, path: 'x/due.md' }),
    ).toMatchObject({ action: 'create' })
  })
})

describe('wikiProposePage: percorso, dimensione, frontmatter', () => {
  const BAD = [
    '../x.md',
    'a/../../x.md',
    'a/../b.md',
    '/etc/x.md',
    'a.txt',
    'senza-estensione',
    '.nascosto.md',
    'dir/.git/x.md',
    'a//b.md',
    'a\\b.md',
    'x/.md',
    'index.md',
    'log.md',
    'sources.md',
    'overview.md',
    'a/b\0c.md',
    '',
    'x'.repeat(300) + '.md',
  ]
  it.each(BAD)(
    'percorso non valido %j: messaggio generico, nessuna chiamata a GitHub',
    async (p) => {
      env = await makeProposalEnv()
      const r = await env.run(alice, { path: p, content: VALID() })
      expect(failure(r)).toBe(PATH_DENIED_MESSAGE)
      expect(env.fake.requests).toHaveLength(0)
      expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'path-not-allowed' })
    },
  )

  it('index.md in una sottocartella è un percorso valido; pathProblem su casi limite', () => {
    expect(pathProblem('concetti/index.md')).toBeUndefined()
    expect(pathProblem('concetti/a b è.md')).toBeUndefined()
    expect(pathProblem('index.md')).toBe('riservato')
  })

  it('contenuto troppo grande o vuoto, motivazione troppo lunga', async () => {
    env = await makeProposalEnv({ overrides: { maxContentChars: 300, maxRationaleChars: 20 } })
    expect(failure(await env.run(alice, { ...OK, content: VALID() + 'x'.repeat(400) }))).toMatch(
      /troppo grande/,
    )
    expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'invalid-content' })
    expect(failure(await env.run(alice, { ...OK, content: '  \n' }))).toMatch(/vuoto/)
    expect(failure(await env.run(alice, { ...OK, rationale: 'y'.repeat(21) }))).toMatch(
      /motivazione/,
    )
    expect(env.fake.requests).toHaveLength(0)
  })

  it('frontmatter non valido: errore descrittivo mostrato al proponente (stesso validateFrontmatter di writePage)', async () => {
    env = await makeProposalEnv()
    const senza = failure(await env.run(alice, { ...OK, content: '# solo testo\n' }))
    expect(senza).toMatch(/Frontmatter non valido/)
    expect(senza).toMatch(/tipo/)
    const visib = failure(
      await env.run(alice, { ...OK, content: VALID('visibilita: segretissima') }),
    )
    expect(visib).toMatch(/visibilita/)
    const yamlRotto = failure(await env.run(alice, { ...OK, content: '---\ntipo: [\n---\nx' }))
    expect(yamlRotto).not.toMatch(/\n/)
    expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'invalid-content' })
    expect(env.fake.requests).toHaveLength(0)
  })
})

describe('wikiProposePage: pagine esistenti e visibilità', () => {
  it('pagina esistente NON visibile: risposta identica a «percorso non consentito», audit visibility', async () => {
    env = await makeProposalEnv()
    const nascosta = await env.run(alice, { path: 'riservate/legale.md', content: VALID() })
    const vietato = await env.run(alice, { path: '../fuori.md', content: VALID() })
    expect(nascosta).toEqual(vietato)
    expect(failure(nascosta)).toBe(PATH_DENIED_MESSAGE)
    expect(env.fake.requests).toHaveLength(0)
    const events = env.events('audit')
    expect(events[0]).toMatchObject({ outcome: 'denied', reason: 'visibility' })
    expect(events[1]).toMatchObject({ outcome: 'denied', reason: 'path-not-allowed' })
    // la risposta non contiene il percorso né la parola «esiste»
    expect(JSON.stringify(nascosta)).not.toMatch(/legale|esist/i)
  })

  it('canWrite negato anche con contenuto che dichiara il gruppo giusto (non si scavalca con il frontmatter)', async () => {
    env = await makeProposalEnv()
    const r = await env.run(alice, {
      path: 'riservate/legale.md',
      content: VALID('visibilita: riservata\ngruppi: [hr, legal]'),
    })
    expect(failure(r)).toBe(PATH_DENIED_MESSAGE)
    expect(env.fake.pulls).toHaveLength(0)
  })

  it('pagina riservata del proprio gruppo: modifica ok se visibilita/gruppi restano uguali', async () => {
    env = await makeProposalEnv({ seed: { 'wiki/riservate/hr.md': '# vecchia\n' } })
    const r = await env.run(alice, {
      path: 'riservate/hr.md',
      content: VALID('visibilita: riservata\ngruppi: [hr]'),
    })
    expect(r).toMatchObject({ action: 'update' })
  })

  it('un non-admin non può abbassare la visibilità di una riservata, anche se ne ha accesso', async () => {
    env = await makeProposalEnv({ seed: { 'wiki/riservate/hr.md': '# vecchia\n' } })
    for (const extra of [
      'visibilita: pubblica',
      '',
      'visibilita: interna',
      'visibilita: riservata\ngruppi: [hr, it]',
      'visibilita: riservata',
    ]) {
      const r = await env.run(alice, { path: 'riservate/hr.md', content: VALID(extra) })
      expect(failure(r), extra).toMatch(/admin/)
      expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'visibility' })
    }
    expect(env.fake.pulls).toHaveLength(0)
  })

  it('un non-admin non può nemmeno rendere riservata una pagina aperta; pubblica -> interna è ammesso', async () => {
    env = await makeProposalEnv()
    expect(
      failure(
        await env.run(alice, {
          path: 'concetti/aperta.md',
          content: VALID('visibilita: riservata\ngruppi: [hr]'),
        }),
      ),
    ).toMatch(/admin/)
    expect(
      await env.run(alice, { path: 'concetti/aperta.md', content: VALID('visibilita: interna') }),
    ).toMatchObject({ action: 'update' })
  })

  it('l admin può cambiare visibilità e gruppi, e vede ogni pagina', async () => {
    env = await makeProposalEnv({ seed: { 'wiki/riservate/legale.md': '# v\n' } })
    expect(
      await env.run(admin, { path: 'riservate/legale.md', content: VALID('visibilita: pubblica') }),
    ).toMatchObject({ action: 'update' })
  })

  it('pagina nuova riservata: serve un proprio gruppo tra i gruppi indicati (o admin)', async () => {
    env = await makeProposalEnv()
    const nuovaDi = (extra: string, p = alice) =>
      env.run(p, { path: 'riservate/nuova.md', content: VALID(extra) })
    expect(failure(await nuovaDi('visibilita: riservata\ngruppi: [legal]'))).toMatch(/tuoi/)
    expect(failure(await nuovaDi('visibilita: riservata'))).toMatch(/tuoi/)
    expect(failure(await nuovaDi('visibilita: riservata\ngruppi: []'))).toMatch(/tuoi/)
    expect(last(env)).toMatchObject({ reason: 'visibility' })
    expect(env.fake.pulls).toHaveLength(0)
    expect(await nuovaDi('visibilita: riservata\ngruppi: [hr]')).toMatchObject({ action: 'create' })
    expect(await nuovaDi('visibilita: riservata', admin)).toMatchObject({ action: 'create' })
  })

  it('pagina presente sul repo ma non sul server (sync in ritardo): stessa risposta generica', async () => {
    env = await makeProposalEnv({ seed: { 'wiki/concetti/solo-remoto.md': '# r\n' } })
    const r = await env.run(alice, { path: 'concetti/solo-remoto.md', content: VALID() })
    expect(failure(r)).toBe(PATH_DENIED_MESSAGE)
    expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'not-synced' })
    expect(env.fake.branches.size).toBe(1)
  })

  it('una cartella al posto di una pagina non è proponibile', async () => {
    env = await makeProposalEnv()
    fs.mkdirSync(path.join(env.fx.wikiDir, 'cartella.md'))
    expect(failure(await env.run(alice, { path: 'cartella.md', content: VALID() }))).toBe(
      PATH_DENIED_MESSAGE,
    )
  })
})

describe('wikiProposePage: limiti di abuso', () => {
  it('rate limit per principal con finestra fissa', async () => {
    let t = 1_000_000
    env = await makeProposalEnv({
      overrides: { rateLimitMax: 2, rateLimitWindowSeconds: 600 },
      now: () => t,
    })
    const p = (n: number) => env.run(alice, { path: `x/p${n}.md`, content: VALID() })
    expect(await p(1)).toMatchObject({ action: 'create' })
    expect(await p(2)).toMatchObject({ action: 'create' })
    const third = await p(3)
    expect(failure(third)).toMatch(/Troppe proposte/)
    expect(last(env)).toMatchObject({ outcome: 'denied', reason: 'rate-limited' })
    // un altro principal ha il suo contatore
    expect(await env.run(principal('bruno-1'), OK)).toMatchObject({ action: 'create' })
    // dopo la finestra si riparte
    t += 601_000
    expect(await p(4)).toMatchObject({ action: 'create' })
    expect(env.fake.pulls).toHaveLength(4)
  })

  it('anche i rifiuti sul percorso contano nel rate limit (niente oracolo gratuito)', async () => {
    env = await makeProposalEnv({ overrides: { rateLimitMax: 3 } })
    for (let i = 0; i < 3; i++)
      await env.run(alice, { path: 'riservate/legale.md', content: VALID() })
    expect(
      failure(await env.run(alice, { path: 'riservate/legale.md', content: VALID() })),
    ).toMatch(/Troppe/)
  })

  it('tetto alle PR di proposta aperte dal bot: le altre PR non contano', async () => {
    env = await makeProposalEnv({ overrides: { maxOpenPulls: 2 } })
    env.fake.branches.set('feature/altro', new Map())
    env.fake.pulls.push({
      number: 99,
      title: '',
      body: '',
      head: 'feature/altro',
      base: 'main',
      labels: [],
      html_url: '',
    })
    expect(await env.run(alice, { path: 'x/1.md', content: VALID() })).toMatchObject({
      action: 'create',
    })
    expect(await env.run(alice, { path: 'x/2.md', content: VALID() })).toMatchObject({
      action: 'create',
    })
    expect(failure(await env.run(alice, { path: 'x/3.md', content: VALID() }))).toMatch(
      /troppe proposte/,
    )
    expect(last(env)).toMatchObject({ reason: 'open-prs-limit' })
    expect(env.fake.pulls.filter((q) => q.head.startsWith('proposta/'))).toHaveLength(2)
  })
})

describe('wikiProposePage: errori di GitHub', () => {
  it('errore dopo la creazione del branch: ripulisce il branch, messaggio breve senza dettagli né token', async () => {
    env = await makeProposalEnv()
    env.fake.failNext('POST', /\/pulls$/, 500, 'Internal detail SECRET-STACK')
    const r = await env.run(alice, OK)
    const msg = failure(r)
    expect(msg).toMatch(/GitHub/)
    expect(msg).not.toMatch(/SECRET|500|ghp_/)
    expect(env.fake.requests.some((q) => q.method === 'DELETE')).toBe(true)
    expect([...env.fake.branches.keys()]).toEqual(['main'])
    expect(last(env)).toMatchObject({ outcome: 'error' })
    expect(last(env).branch).toMatch(/^proposta\//)
    expect(await env.tel.metrics.renderText()).toContain(
      'wiki_mcp_proposals_total{wiki="test",outcome="error"} 1',
    )
  })

  it('errore alla scrittura del file (conflitto di SHA): messaggio chiaro e ripulitura', async () => {
    env = await makeProposalEnv()
    env.fake.failNext('PUT', /\/contents\//, 409, 'wiki/concetti/aperta.md does not match abc')
    const r = await env.run(alice, { path: 'concetti/aperta.md', content: VALID() })
    expect(failure(r)).toMatch(/cambiata nel frattempo/)
    expect([...env.fake.branches.keys()]).toEqual(['main'])
  })

  it('se anche la ripulitura fallisce lo si logga, senza nascondere l errore originale', async () => {
    env = await makeProposalEnv()
    env.fake.failNext('PUT', /\/contents\//, 500)
    env.fake.failAlways('DELETE', /\/git\/refs\//, 500)
    expect(failure(await env.run(alice, OK))).toMatch(/GitHub/)
    expect(env.events('proposal-cleanup-failed')).toHaveLength(1)
  })

  it('timeout: messaggio dedicato, nessun branch creato se scade prima', async () => {
    env = await makeProposalEnv({ timeoutMs: 200 })
    env.fake.failAlways('GET', /\/pulls$/, 200, { delayMs: 1000 })
    expect(failure(await env.run(alice, OK))).toMatch(/in tempo/)
    expect(env.fake.branches.size).toBe(1)
  })

  it('token GitHub errato: errore di configurazione senza rivelare il token', async () => {
    env = await makeProposalEnv({ token: 'ghp_SBAGLIATO_0000' })
    const msg = failure(await env.run(alice, OK))
    expect(msg).toMatch(/accedere al repository/)
    expect(JSON.stringify(env.lines)).not.toContain('ghp_SBAGLIATO_0000')
  })
})

describe('wikiProposePage: audit e metriche', () => {
  it('l evento audit ha solo path e lunghezze, azione, prUrl e branch: mai contenuto, motivazione, token', async () => {
    env = await makeProposalEnv()
    const SECRET = 'CONTENUTO-SEGRETISSIMO-QQ'
    const RAT = 'MOTIVAZIONE-LUNGA-DA-NON-LOGGARE-ZZ'
    const r = (await env.run(alice, {
      path: 'concetti/nuova.md',
      content: VALID() + SECRET,
      rationale: RAT,
      title: 'TITOLO-X',
    })) as { prUrl: string; branch: string }
    const ev = last(env)
    expect(ev).toMatchObject({
      tool: 'wikiProposePage',
      outcome: 'ok',
      action: 'create',
      prUrl: r.prUrl,
      branch: r.branch,
      prNumber: 1,
      principal: { id: 'alice-1', user: 'alice' },
    })
    expect(Object.keys(ev.args).sort()).toEqual([
      'contentLength',
      'path',
      'rationaleLength',
      'titleLength',
    ])
    expect(ev.args.rationaleLength).toBe(RAT.length)
    expect(ev.resultSize).toBeGreaterThan(0)
    const all = JSON.stringify(env.lines)
    for (const leak of [SECRET, RAT, 'TITOLO-X', env.fake.token]) expect(all).not.toContain(leak)
    expect(await env.tel.metrics.renderText()).toContain(
      'wiki_mcp_proposals_total{wiki="test",outcome="created"} 1',
    )
    expect(await env.tel.metrics.renderText()).toContain(
      'wiki_mcp_tool_calls_total{wiki="test",tool="wikiProposePage",outcome="ok"} 1',
    )
  })

  it('i motivi di denied vengono da un vocabolario chiuso', async () => {
    env = await makeProposalEnv({ overrides: { rateLimitMax: 100 } })
    await env.run(undefined, OK)
    await env.run(alice, { path: '../x.md', content: 'x' })
    await env.run(alice, { ...OK, content: 'niente' })
    await env.run(alice, { path: 'riservate/legale.md', content: VALID() })
    const reasons = new Set(env.events('audit').map((e) => e.reason))
    const closed = ['propose-not-allowed', 'path-not-allowed', 'invalid-content', 'visibility']
    expect([...reasons].sort()).toEqual([...closed].sort())
    expect(await env.tel.metrics.renderText()).toContain(
      'wiki_mcp_proposals_total{wiki="test",outcome="denied"} 4',
    )
  })
})

describe('branchName', () => {
  it('slug dell utente e della pagina, timestamp UTC e suffisso casuale', () => {
    const n = branchName('Àlice Rossi', 'concetti/Verbale Uno.md', Date.UTC(2026, 9, 30, 10, 15, 0))
    expect(n).toMatch(/^proposta\/alice-rossi-concetti-verbale-uno-20261030T101500Z-[0-9a-f]{4}$/)
  })
})

it('fixture sanity: le pagine di prova esistono', () => {
  expect(Object.keys(WIKI_FILES)).toContain('riservate/legale.md')
})
