import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getGraph } from '../wiki/service.js'

export const wikiGraphTool = createTool({
  id: 'wiki_graph',
  description: 'Restituisce il grafo dei wikilink [[...]] tra le pagine. Chiave = slug pagina, valore = lista di slug collegati.',
  inputSchema: z.object({}),
  execute: async () => getGraph(),
})
