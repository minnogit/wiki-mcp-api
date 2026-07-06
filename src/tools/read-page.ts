import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getPage } from '../wiki/service.js'

export const wikiReadPageTool = createTool({
  id: 'wiki_read_page',
  description: 'Legge una pagina wiki completa con frontmatter YAML e contenuto Markdown. Usa lo slug relativo, es. "concetti/posizione-debitoria".',
  inputSchema: z.object({
    slug: z.string().describe('Slug della pagina, es. "concetti/posizione-debitoria" o "analisi/business-rules-engine"'),
  }),
  execute: async ({ slug }) => {
    const page = getPage(slug)
    if (!page) return { error: `Pagina non trovata: ${slug}` }
    return page
  },
})
