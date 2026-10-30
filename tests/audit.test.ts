import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDITED_TOOLS,
  type ExecutableTool,
  DeniedError,
  emitDenied,
  reduceArgs,
  withAudit,
  type AuditContext,
} from '../src/audit.js'
import { runWithPrincipal, type Principal } from '../src/auth.js'
import { buildServer } from '../src/server.js'
import { cleanup, frontmatter, setupService } from './helpers'
import { SECRET_CONTENT, makeTelemetry } from './obs-helpers'

let fixture: ReturnType<typeof setupService> | null = null
afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

const alice: Principal = Object.freeze({
  id: 'alice-1',
  user: 'alice',
  groups: [],
  wikis: ['test'],
})

type Exec = (input: unknown, ctx: unknown) => Promise<unknown>

function setup(opts: { queryMaxChars?: number } = {}) {
  fixture = setupService(
    { 'concetti/uno.md': frontmatter() + '# Uno\n\nTesto.\n', 'log.md': '# Log\n' },
    { 'verbale.md': 'contenuto raw' },
  )
  const t = makeTelemetry(opts)
  const server = buildServer(fixture.svc, t.tel)
  const run = (name: string, input: unknown = {}, p: Principal | null = alice) => {
    const tool = (server.tools() as Record<string, { execute: Exec }>)[name]
    const call = () => tool.execute(input, {})
    return p ? runWithPrincipal(p, call) : call()
  }
  return { ...t, run, svc: fixture.svc }
}

describe('audit: un evento per ogni tool', () => {
  const CASES: [string, unknown][] = [
    ['wikiSearch', { q: 'uno', topK: 5, tag: 'test' }],
    ['wikiReadPage', { slug: 'concetti/uno' }],
    ['wikiListPages', { categoria: 'concetti' }],
    ['wikiGraph', {}],
    ['wikiStatus', {}],
    ['wikiListRaw', {}],
    ['wikiReadRaw', { filename: 'verbale.md' }],
    ['wikiRawDiff', { filename: 'verbale.md' }],
    ['wikiChecksum', { path: 'concetti/uno.md' }],
    [
      'wikiWritePage',
      { path: 'concetti/nuova.md', content: frontmatter() + `# N\n\n${SECRET_CONTENT}\n` },
    ],
    ['wikiAppendLog', { entry: `## [2026-01-01] test | ${SECRET_CONTENT}` }],
  ]

  it.each(CASES)(
    '%s: evento audit ok con principal, wiki, durata e requestId',
    async (name, input) => {
      const { run, events } = setup()
      await run(name, input)
      const [e] = events('audit')
      expect(e).toMatchObject({
        event: 'audit',
        level: 'info',
        principal: { id: 'alice-1', user: 'alice' },
        wiki: 'test',
        tool: name,
        outcome: 'ok',
      })
      expect(e.requestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(typeof e.durationMs).toBe('number')
      expect(typeof e.ts).toBe('string')
    },
  )

  it('copre tutti i tool del server completo con una regola di args', () => {
    setup()
    const server = buildServer(fixture!.svc, makeTelemetry().tel)
    for (const name of Object.keys(server.tools())) expect(AUDITED_TOOLS).toContain(name)
  })

  it('il principal non include token né hash né gruppi', async () => {
    const { run, lines } = setup()
    await run('wikiStatus')
    const e = JSON.parse(lines[0]) as { principal: object }
    expect(Object.keys(e.principal).sort()).toEqual(['id', 'user'])
  })

  it('senza principal (stdio locale) è registrato come "local"', async () => {
    const { run, events } = setup()
    await run('wikiStatus', {}, null)
    expect(events('audit')[0].principal).toEqual({ id: 'local', user: 'local' })
  })

  it('resultSize: numero di risultati per gli elenchi, byte per gli altri', async () => {
    const { run, events } = setup()
    await run('wikiSearch', { q: 'uno' })
    await run('wikiReadPage', { slug: 'concetti/uno' })
    const [search, read] = events('audit')
    expect(search.resultSize).toBe(1)
    expect(read.resultSize).toBeGreaterThan(10)
  })

  it('args ridotti: la query è troncata a queryMaxChars e ne resta la lunghezza', async () => {
    const { run, events } = setup({ queryMaxChars: 10 })
    await run('wikiSearch', { q: 'abcdefghijklmnopqrstuvwxyz', tipo: 'concetto', topK: 3 })
    expect(events('audit')[0].args).toEqual({
      q: 'abcdefghij…',
      qLength: 26,
      tipo: 'concetto',
      topK: 3,
    })
  })

  it('scrittura: solo path e lunghezza, MAI il contenuto', async () => {
    const { run, events, lines } = setup()
    const content = frontmatter() + `# N\n\n${SECRET_CONTENT}\n`
    await run('wikiWritePage', { path: 'concetti/nuova.md', content })
    await run('wikiAppendLog', { entry: `## [2026-01-01] x | ${SECRET_CONTENT}` })
    const [w, a] = events('audit')
    expect(w.args).toEqual({ path: 'concetti/nuova.md', contentLength: content.length })
    expect(Object.keys(a.args)).toEqual(['entryLength'])
    expect(lines.join('\n')).not.toContain(SECRET_CONTENT)
  })

  it('errore restituito dal tool nel risultato: outcome error con messaggio breve', async () => {
    const { run, events } = setup()
    await run('wikiReadPage', { slug: 'non/esiste' })
    expect(events('audit')[0]).toMatchObject({
      outcome: 'error',
      error: 'Pagina non trovata: non/esiste',
    })
    expect(events('audit')[0].resultSize).toBeUndefined()
  })

  it('scrittura fallita (frontmatter non valido): error, e il contenuto non compare', async () => {
    const { run, events, lines } = setup()
    await run('wikiWritePage', {
      path: 'concetti/rotta.md',
      content: `senza frontmatter ${SECRET_CONTENT}`,
    })
    expect(events('audit')[0].outcome).toBe('error')
    expect(lines.join('\n')).not.toContain(SECRET_CONTENT)
  })

  it('risultato { error: true, message } con gli argomenti nel messaggio: solo la prima riga', async () => {
    const { tel, events, lines } = makeTelemetry()
    const t = withAudit(
      'wikiWritePage',
      fake(() => ({
        error: true,
        message: `Tool input validation failed.\n\nProvided arguments: {"content":"${SECRET_CONTENT}"}`,
      })),
      ctxOf(tel),
    )
    await invoke(t)
    expect(events('audit')[0]).toMatchObject({
      outcome: 'error',
      error: 'Tool input validation failed.',
    })
    expect(lines.join('\n')).not.toContain(SECRET_CONTENT)
  })

  it('eccezione lanciata: error con messaggio senza percorsi assoluti, e viene rilanciata', async () => {
    const { tel, events, lines } = makeTelemetry()
    const ctx = ctxOf(tel)
    const boom = withAudit(
      'wikiReadPage',
      fake(() => Promise.reject(new Error("ENOENT: '/srv/wiki/segreto/x.md'"))),
      ctx,
    )
    await expect(invoke(boom)).rejects.toThrow('ENOENT')
    expect(events('audit')[0]).toMatchObject({ outcome: 'error', error: "ENOENT: '<percorso>'" })
    expect(lines.join('')).not.toContain('/srv/wiki')
  })

  it('un tool fuori tabella è audito con args vuoti', async () => {
    const { tel, events } = makeTelemetry()
    const t = withAudit(
      'toolNuovo',
      fake(() => ({ ok: 1 })),
      ctxOf(tel),
    )
    await invoke(t, { segreto: 'x' })
    expect(events('audit')[0]).toMatchObject({ tool: 'toolNuovo', args: {} })
  })

  it('il tool originale non è modificato', () => {
    const { tel } = makeTelemetry()
    const orig = { execute: () => 1 }
    const wrapped = withAudit('wikiStatus', orig, ctxOf(tel))
    expect(wrapped).not.toBe(orig)
    expect(orig.execute()).toBe(1)
  })
})

// Tool finto con execute arbitrario, e la sua invocazione come la fa MCPServer.
const fake = (execute: () => unknown): ExecutableTool => ({ execute })
const invoke = (t: ExecutableTool, input: unknown = {}): Promise<unknown> =>
  Promise.resolve((t.execute as (i: unknown, c: unknown) => unknown)(input, {}))

function ctxOf(tel: ReturnType<typeof makeTelemetry>['tel'], wiki = 'test'): AuditContext {
  return { wiki, auditor: tel.auditor, metrics: tel.metrics, queryMaxChars: tel.queryMaxChars }
}

describe('esito denied', () => {
  it('emitDenied scrive un evento denied con motivo, args ridotti e metrica', async () => {
    const { tel, events } = makeTelemetry()
    runWithPrincipal(alice, () =>
      emitDenied(ctxOf(tel), 'wikiReadPage', 'pagina fuori dai permessi', {
        slug: 'riservato/x',
        extra: SECRET_CONTENT,
      }),
    )
    expect(events('audit')[0]).toMatchObject({
      outcome: 'denied',
      tool: 'wikiReadPage',
      reason: 'pagina fuori dai permessi',
      principal: { id: 'alice-1', user: 'alice' },
      args: { slug: 'riservato/x' },
      durationMs: 0,
    })
    expect(await tel.metrics.renderText()).toContain(
      'wiki_mcp_tool_calls_total{wiki="test",tool="wikiReadPage",outcome="denied"} 1',
    )
  })

  it('DeniedError lanciata da un tool diventa outcome denied e viene rilanciata', async () => {
    const { tel, events } = makeTelemetry()
    const t = withAudit(
      'wikiReadPage',
      fake(() => {
        throw new DeniedError('vietato', 'gruppo mancante')
      }),
      ctxOf(tel),
    )
    await expect(invoke(t)).rejects.toBeInstanceOf(DeniedError)
    expect(events('audit')[0]).toMatchObject({ outcome: 'denied', reason: 'gruppo mancante' })
    expect(events('audit')[0].error).toBeUndefined()
  })

  it('reduceArgs è difensiva con input malformato', () => {
    expect(reduceArgs('wikiSearch', null, 10)).toEqual({})
    expect(reduceArgs('wikiSearch', { q: 5, topK: 'x' }, 10)).toEqual({})
    expect(reduceArgs('nonEsiste', { a: 1 }, 10)).toEqual({})
  })
})
