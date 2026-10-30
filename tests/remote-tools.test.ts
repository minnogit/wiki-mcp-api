import { afterEach, describe, expect, it } from 'vitest'
import { buildRemoteServer, buildServer, rawOverHttp } from '../src/server.js'
import { cleanup, makeService, setupService } from './helpers'

const PAGE_TOOLS = ['wikiGraph', 'wikiListPages', 'wikiReadPage', 'wikiSearch', 'wikiStatus']
const SOURCE_TOOLS = ['wikiChecksum', 'wikiListRaw', 'wikiRawDiff', 'wikiReadRaw']
const WRITE_TOOLS = ['wikiAppendLog', 'wikiWritePage']

let fixture: ReturnType<typeof setupService> | null = null

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

function service(opts: { withRaw?: boolean; name?: string; domain?: string } = {}) {
  fixture = setupService()
  return makeService(fixture.wikiDir, opts.withRaw === false ? undefined : fixture.rawDir, {
    name: opts.name,
    domain: opts.domain,
  })
}

const toolNames = (s: { tools(): Record<string, unknown> }): string[] =>
  Object.keys(s.tools()).sort()

describe('rawOverHttp (MCP_HTTP_EXPOSE_RAW)', () => {
  it('vale solo col valore esatto "true"', () => {
    expect(rawOverHttp({ MCP_HTTP_EXPOSE_RAW: 'true' })).toBe(true)
    for (const value of [undefined, '1', 'TRUE', 'True', 'yes', 'false', '']) {
      expect(rawOverHttp({ MCP_HTTP_EXPOSE_RAW: value })).toBe(false)
    }
  })
})

describe('tool esposti dal server HTTP remoto', () => {
  it('di default serve solo le pagine: niente sorgenti, niente scrittura', () => {
    expect(toolNames(buildRemoteServer(service(), { exposeRaw: false }))).toEqual(PAGE_TOOLS)
  })

  it('legge exposeRaw dall ambiente se non è passato esplicitamente', () => {
    const original = process.env.MCP_HTTP_EXPOSE_RAW
    try {
      process.env.MCP_HTTP_EXPOSE_RAW = 'true'
      expect(toolNames(buildRemoteServer(service()))).toEqual(
        [...PAGE_TOOLS, ...SOURCE_TOOLS].sort(),
      )
      process.env.MCP_HTTP_EXPOSE_RAW = '1'
      expect(toolNames(buildRemoteServer(service()))).toEqual(PAGE_TOOLS)
    } finally {
      if (original === undefined) delete process.env.MCP_HTTP_EXPOSE_RAW
      else process.env.MCP_HTTP_EXPOSE_RAW = original
    }
  })

  it('con exposeRaw monta anche i tool sulle sorgenti, mai la scrittura', () => {
    const remote = buildRemoteServer(service(), { exposeRaw: true })
    expect(toolNames(remote)).toEqual([...PAGE_TOOLS, ...SOURCE_TOOLS].sort())
    for (const w of WRITE_TOOLS) expect(toolNames(remote)).not.toContain(w)
  })

  it('wikiChecksum segue le sorgenti: da remoto controlla anche raw/, quindi non si espone da solo', () => {
    expect(toolNames(buildRemoteServer(service(), { exposeRaw: false }))).not.toContain(
      'wikiChecksum',
    )
  })

  it('una wiki senza rawDir non monta i tool sulle sorgenti nemmeno con exposeRaw', () => {
    const remote = buildRemoteServer(service({ withRaw: false }), { exposeRaw: true })
    expect(toolNames(remote)).toEqual(PAGE_TOOLS)
    expect(remote.instructions).not.toContain('INGEST')
  })
})

describe('server stdio locale', () => {
  it('espone tutti i tool', () => {
    const all = [...PAGE_TOOLS, ...SOURCE_TOOLS, ...WRITE_TOOLS].sort()
    expect(toolNames(buildServer(service()))).toEqual(all)
  })

  it('senza rawDir niente tool sulle sorgenti, la scrittura resta', () => {
    expect(toolNames(buildServer(service({ withRaw: false })))).toEqual(
      [...PAGE_TOOLS, ...WRITE_TOOLS].sort(),
    )
  })
})

describe('instructions inviate al client', () => {
  it('quelle remote senza sorgenti non descrivono l’INGEST né i tool raw', () => {
    const text = buildRemoteServer(service(), { exposeRaw: false }).instructions ?? ''
    expect(text).toContain('QUERY')
    expect(text).not.toContain('INGEST')
    expect(text).not.toContain('wikiReadRaw e wikiRawDiff sono read-only')
    expect(text).toContain('solo le pagine della wiki')
  })

  it('quelle stdio e quelle remote con le sorgenti descrivono l’INGEST', () => {
    for (const s of [buildServer(service()), buildRemoteServer(service(), { exposeRaw: true })]) {
      expect(s.instructions ?? '').toContain('INGEST')
    }
  })

  it('la riga di dominio viene dal contesto della wiki, con un default neutro', () => {
    const text = (s: { instructions?: string }) => s.instructions ?? ''
    expect(text(buildServer(service({ domain: 'Dominio HR.' })))).toMatch(/^Dominio HR\./)
    expect(text(buildServer(service()))).toMatch(/^Questa wiki documenta un dominio/)
  })
})

describe('identità dei server', () => {
  it('la wiki default mantiene id e nome storici, le altre aggiungono il nome', () => {
    expect(buildServer(service({ name: 'default' })).id).toBe('wiki-mcp')
    expect(buildServer(service({ name: 'hr' })).id).toBe('wiki-mcp-hr')
    expect(buildRemoteServer(service({ name: 'hr' }), { exposeRaw: false }).id).toBe(
      'wiki-mcp-readonly-hr',
    )
  })
})
