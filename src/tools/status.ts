import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getStatus } from '../wiki/service.js'

export const wikiStatusTool = createTool({
  id: 'wiki_status',
  description: 'Restituisce lo stato della wiki: numero totale di pagine, distribuzione per tipo e per stato, data ultimo aggiornamento. La data è il frontmatter `aggiornato` più recente; per le pagine senza frontmatter valido (es. log.md) si usa la data di modifica del file.',
  inputSchema: z.object({}),
  execute: async () => getStatus(),
})
