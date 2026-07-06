import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { listRaw, readRaw } from '../wiki/service.js'

export const wikiListRawTool = createTool({
  id: 'wiki_list_raw',
  description: 'Elenca i file nella directory raw/ (sorgenti immutabili)',
  inputSchema: z.object({}),
  execute: async () => listRaw(),
})

export const wikiReadRawTool = createTool({
  id: 'wiki_read_raw',
  description: 'Legge un file dalla directory raw/ (sola lettura). Usa il filename senza path, es. "flusso_pagamenti.md".',
  inputSchema: z.object({
    filename: z.string().describe('Nome del file in raw/, es. "flusso_pagamenti.md"'),
  }),
  execute: async ({ filename }) => {
    try {
      return { content: readRaw(filename) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
})
