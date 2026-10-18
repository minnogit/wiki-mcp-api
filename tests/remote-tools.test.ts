import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE_TOOLS = ['wikiGraph', 'wikiListPages', 'wikiReadPage', 'wikiSearch', 'wikiStatus']
const SOURCE_TOOLS = ['wikiChecksum', 'wikiListRaw', 'wikiRawDiff', 'wikiReadRaw']
const WRITE_TOOLS = ['wikiAppendLog', 'wikiWritePage']

const original = process.env.MCP_HTTP_EXPOSE_RAW

// server.ts legge MCP_HTTP_EXPOSE_RAW al load del modulo: ogni caso imposta l'env PRIMA
// dell'import dinamico, con il reset dei moduli per non ricevere l'istanza del caso precedente.
async function loadServer(exposeRaw?: string) {
  if (exposeRaw === undefined) delete process.env.MCP_HTTP_EXPOSE_RAW
  else process.env.MCP_HTTP_EXPOSE_RAW = exposeRaw
  vi.resetModules()
  return import('../src/server.js')
}

const toolNames = (s: { tools(): Record<string, unknown> }): string[] =>
  Object.keys(s.tools()).sort()

beforeEach(() => {
  delete process.env.MCP_HTTP_EXPOSE_RAW
})

afterEach(() => {
  if (original === undefined) delete process.env.MCP_HTTP_EXPOSE_RAW
  else process.env.MCP_HTTP_EXPOSE_RAW = original
})

describe('tool esposti dal server HTTP remoto', () => {
  it('di default serve solo le pagine: niente sorgenti, niente scrittura', async () => {
    const { remoteServer, rawOverHttp } = await loadServer()
    expect(rawOverHttp).toBe(false)
    expect(toolNames(remoteServer)).toEqual(PAGE_TOOLS)
  })

  it('con MCP_HTTP_EXPOSE_RAW=true monta anche i tool sulle sorgenti, mai la scrittura', async () => {
    const { remoteServer, rawOverHttp } = await loadServer('true')
    expect(rawOverHttp).toBe(true)
    expect(toolNames(remoteServer)).toEqual([...PAGE_TOOLS, ...SOURCE_TOOLS].sort())
    for (const w of WRITE_TOOLS) expect(toolNames(remoteServer)).not.toContain(w)
  })

  it.each(['1', 'TRUE', 'True', 'yes', 'false', ''])(
    'tratta "%s" come spento: serve il valore esatto "true"',
    async (value) => {
      const { remoteServer, rawOverHttp } = await loadServer(value)
      expect(rawOverHttp).toBe(false)
      expect(toolNames(remoteServer)).toEqual(PAGE_TOOLS)
    },
  )

  it('wikiChecksum segue le sorgenti: da remoto controlla anche raw/, quindi non si espone da solo', async () => {
    const { remoteServer } = await loadServer()
    expect(toolNames(remoteServer)).not.toContain('wikiChecksum')
  })
})

describe('server stdio locale', () => {
  it('espone sempre tutti i tool, qualunque sia MCP_HTTP_EXPOSE_RAW', async () => {
    const all = [...PAGE_TOOLS, ...SOURCE_TOOLS, ...WRITE_TOOLS].sort()
    for (const value of [undefined, 'true', 'false']) {
      const { server } = await loadServer(value)
      expect(toolNames(server)).toEqual(all)
    }
  })
})

describe('instructions inviate al client', () => {
  it('quelle remote senza sorgenti non descrivono l’INGEST né i tool raw', async () => {
    const { remoteServer } = await loadServer()
    const text = remoteServer.instructions ?? ''
    expect(text).toContain('QUERY')
    expect(text).not.toContain('INGEST')
    expect(text).not.toContain('wikiReadRaw e wikiRawDiff sono read-only')
    expect(text).toContain('solo le pagine della wiki')
  })

  it('quelle stdio e quelle remote con le sorgenti descrivono l’INGEST', async () => {
    const { server, remoteServer } = await loadServer('true')
    for (const s of [server, remoteServer]) {
      const text = s.instructions ?? ''
      expect(text).toContain('INGEST')
    }
  })
})
