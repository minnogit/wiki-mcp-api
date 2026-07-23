import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { writePage } from '../wiki/service.js'

export const wikiWritePageTool = createTool({
  id: 'wiki_write_page',
  description:
    'Crea o aggiorna una pagina nella wiki. Scrive SOLO in wiki/, mai in raw/. Il path è relativo alla directory wiki, es. "concetti/nuova-pagina.md". ' +
    'Il frontmatter YAML è validato: tipo (uno tra concetto|soggetto|procedura|normativa|entita|analisi), tags (almeno uno), fonti (array, anche vuoto), ' +
    'aggiornato (formato YYYY-MM-DD) e stato (bozza|stabile|da-rivedere) sono tutti obbligatori, altrimenti la scrittura fallisce con un errore descrittivo. ' +
    'Eccezione: index.md, log.md, sources.md e overview.md nella radice della wiki non richiedono frontmatter.',
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
