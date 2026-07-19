import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { writePage } from '../wiki/service.js'

export const wikiWritePageTool = createTool({
  id: 'wiki_write_page',
  description: 'Crea o aggiorna una pagina nella wiki. Scrive SOLO in wiki/, mai in raw/. Il path è relativo alla directory wiki, es. "concetti/nuova-pagina.md".',
  inputSchema: z.object({
    path: z.string().describe('Path relativo alla wiki dir, es. "concetti/verbale.md"'),
    content: z.string().describe('Contenuto Markdown completo della pagina, incluso frontmatter YAML'),
  }),
  execute: async ({ path, content }) => {
    try {
      await writePage(path, content)
      return { success: true, path }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  },
})
