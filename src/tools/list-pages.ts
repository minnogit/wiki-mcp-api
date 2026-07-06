import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { searchPages } from '../wiki/service.js'

export const wikiListPagesTool = createTool({
  id: 'wiki_list_pages',
  description: 'Elenca tutte le pagine della wiki con metadati (senza contenuto). Opzionalmente filtra per categoria (sottocartella), es. "concetti", "analisi".',
  inputSchema: z.object({
    categoria: z.string().optional().describe('Sottocartella da filtrare, es. "concetti", "analisi", "procedure"'),
  }),
  execute: async ({ categoria }) => {
    const pages = searchPages({})
    if (!categoria) return pages
    return pages.filter(p => p.path.startsWith(categoria + '/'))
  },
})
