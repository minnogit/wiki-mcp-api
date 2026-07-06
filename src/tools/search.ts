import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { searchPages } from '../wiki/service.js'

export const wikiSearchTool = createTool({
  id: 'wiki_search',
  description: 'Cerca pagine nella wiki per testo libero, tag, tipo o stato. Restituisce metadati senza il contenuto completo.',
  inputSchema: z.object({
    q: z.string().optional().describe('Testo da cercare in titolo e contenuto'),
    tag: z.string().optional().describe('Filtra per tag esatto'),
    tipo: z.enum(['concetto', 'soggetto', 'procedura', 'normativa', 'entita', 'analisi']).optional(),
    stato: z.enum(['bozza', 'stabile', 'da-rivedere']).optional(),
  }),
  execute: async (input) => searchPages(input),
})
