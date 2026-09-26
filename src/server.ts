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

const instructions = `
Questa wiki documenta il dominio del software PLService per la verbalizzazione del Codice della Strada italiano.

Workflow principali:
- INGEST: usa wiki_list_raw, wiki_read_raw, wiki_checksum, wiki_write_page, wiki_append_log
- QUERY: leggi prima wiki_read_page("index") per individuare le pagine candidate, poi usa wiki_search, wiki_read_page, wiki_list_pages
- LINT: usa wiki_list_pages, wiki_graph, wiki_status

Regole:
- wiki_write_page scrive SOLO in wiki/, mai in raw/
- wiki_write_page valida il frontmatter (tipo/tags/fonti/aggiornato/stato); index.md, log.md, sources.md e overview.md ne sono esenti
- wiki_read_raw è read-only
- I path delle pagine sono relativi alla wiki dir (es. "concetti/verbale.md")
`.trim()

// Server completo (lettura + scrittura), esposto solo via stdio locale (src/stdio.ts).
export const server = new MCPServer({
  id: 'wiki-mcp',
  name: 'LLM Wiki MCP Server',
  version: '0.1.0',
  description: 'Ponte MCP tra agenti AI e la wiki di dominio (verbalizzazione Codice della Strada)',
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
  description: 'Ponte MCP di sola lettura verso la wiki di dominio (verbalizzazione Codice della Strada)',
  instructions: `${instructions}\n\nQuesta istanza è di sola lettura: wiki_write_page e wiki_append_log non sono disponibili qui.`,
  tools: readOnlyTools,
})
