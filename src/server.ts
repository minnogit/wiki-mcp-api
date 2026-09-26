import { MCPServer } from '@mastra/mcp'
import { wikiSearchTool } from './tools/search.js'
import { wikiReadPageTool } from './tools/read-page.js'
import { wikiListPagesTool } from './tools/list-pages.js'
import { wikiWritePageTool } from './tools/write-page.js'
import { wikiAppendLogTool } from './tools/append-log.js'
import { wikiListRawTool, wikiReadRawTool } from './tools/read-raw.js'
import { wikiChecksumTool } from './tools/checksum.js'
import { wikiGraphTool } from './tools/graph.js'
import { wikiStatusTool } from './tools/status.js'

// Tool di sola lettura: sono gli unici esposti al server HTTP remoto (src/http.ts).
// I tool di scrittura (wikiWritePage, wikiAppendLog) restano disponibili solo via stdio locale.
// Questa è una scelta di design deliberata, non solo lo stato attuale: la scrittura via
// stdio presuppone un clone locale della wiki, che dà gratis due garanzie che il codice
// non fornisce altrimenti — attribuzione (il commit è di chi esegue l'agente, con la sua
// identità git) e un checkpoint umano (il diff viene rivisto prima del commit). Un client
// HTTP/remoto non ha né l'uno né l'altro: il lock su singolo file (proper-lockfile) evita
// solo la corruzione concorrente, non risolve conflitti tra scritture di utenti diversi, e
// nessun tool esegue mai commit. Se in futuro si vuole abilitare scrittura remota, queste
// garanzie vanno reintrodotte esplicitamente (auth per-utente, attribuzione, strategia di
// commit/review) prima di spostare un tool di scrittura in readOnlyTools o in remoteServer.
const readOnlyTools = {
  wikiSearch: wikiSearchTool,
  wikiReadPage: wikiReadPageTool,
  wikiListPages: wikiListPagesTool,
  wikiListRaw: wikiListRawTool,
  wikiReadRaw: wikiReadRawTool,
  wikiChecksum: wikiChecksumTool,
  wikiGraph: wikiGraphTool,
  wikiStatus: wikiStatusTool,
}

// Il server è domain-agnostic: la riga che descrive *quale* dominio documenta la
// wiki collegata arriva da WIKI_DOMAIN, insieme a WIKI_PATH/RAW_PATH. Senza di
// essa il client riceverebbe la descrizione del dominio sbagliato non appena si
// configura una seconda istanza sullo stesso binario.
const domainLine =
  process.env.WIKI_DOMAIN?.trim() ||
  'Questa wiki documenta un dominio di conoscenza mantenuto come pagine markdown. Il dominio specifico è descritto nel CLAUDE.md della wiki collegata (accanto a wiki/).'

// I nomi qui devono combaciare con le CHIAVI dell'oggetto `tools` sotto (camelCase):
// è la chiave, non il campo `id` del tool, a diventare il nome esposto via MCP.
const instructions = `
${domainLine}

Workflow principali:
- INGEST: usa wikiListRaw, wikiReadRaw, wikiChecksum, wikiWritePage, wikiAppendLog
- QUERY: leggi prima wikiReadPage("index") per individuare le pagine candidate, poi usa wikiSearch, wikiReadPage, wikiListPages
- LINT: usa wikiListPages, wikiGraph, wikiStatus

Regole:
- wikiWritePage scrive SOLO in wiki/, mai in raw/
- wikiWritePage valida il frontmatter (tipo/tags/fonti/aggiornato/stato); index.md, log.md, sources.md e overview.md ne sono esenti
- wikiReadRaw è read-only
- I path delle pagine sono relativi alla wiki dir (es. "concetti/verbale.md")
`.trim()

// Server completo (lettura + scrittura), esposto solo via stdio locale (src/stdio.ts).
export const server = new MCPServer({
  id: 'wiki-mcp',
  name: 'LLM Wiki MCP Server',
  version: '0.1.0',
  description: 'Ponte MCP tra agenti AI e una wiki di dominio in markdown',
  instructions,
  tools: {
    ...readOnlyTools,
    wikiWritePage: wikiWritePageTool,
    wikiAppendLog: wikiAppendLogTool,
  },
})

// Server di sola lettura, esposto via HTTP per l'accesso remoto (src/http.ts).
// Non include wikiWritePage/wikiAppendLog: la scrittura resta possibile solo in locale.
export const remoteServer = new MCPServer({
  id: 'wiki-mcp-readonly',
  name: 'LLM Wiki MCP Server (read-only)',
  version: '0.1.0',
  description: 'Ponte MCP di sola lettura verso una wiki di dominio in markdown',
  instructions: `${instructions}\n\nQuesta istanza è di sola lettura: wikiWritePage e wikiAppendLog non sono disponibili qui.`,
  tools: readOnlyTools,
})
