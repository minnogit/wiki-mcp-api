import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getStatus } from '../wiki/service.js'

export const wikiStatusTool = createTool({
  id: 'wiki_status',
  description: 'Restituisce lo stato della wiki: numero totale di pagine, distribuzione per tipo e per stato, data ultimo aggiornamento.',
  inputSchema: z.object({}),
  execute: async () => getStatus(),
})
