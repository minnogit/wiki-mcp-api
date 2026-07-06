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

export const server = new MCPServer({
  id: 'wiki-mcp',
  name: 'LLM Wiki MCP Server',
  version: '0.1.0',
  description: 'Ponte MCP tra agenti AI e la wiki di dominio (verbalizzazione Codice della Strada)',
  instructions: `
Questa wiki documenta il dominio del software PLService per la verbalizzazione del Codice della Strada italiano.

Workflow principali:
- INGEST: usa wiki_list_raw, wiki_read_raw, wiki_checksum, wiki_write_page, wiki_append_log
- QUERY: usa wiki_search, wiki_read_page, wiki_list_pages
- LINT: usa wiki_list_pages, wiki_graph, wiki_status

Regole:
- wiki_write_page scrive SOLO in wiki/, mai in raw/
- wiki_read_raw è read-only
- I path delle pagine sono relativi alla wiki dir (es. "concetti/verbale.md")
  `.trim(),
  tools: {
    wikiSearch: wikiSearchTool,
    wikiReadPage: wikiReadPageTool,
    wikiListPages: wikiListPagesTool,
    wikiWritePage: wikiWritePageTool,
    wikiAppendLog: wikiAppendLogTool,
    wikiListRaw: wikiListRawTool,
    wikiReadRaw: wikiReadRawTool,
    wikiChecksum: wikiChecksumTool,
    wikiGraph: wikiGraphTool,
    wikiStatus: wikiStatusTool,
  },
})
