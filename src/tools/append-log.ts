import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { appendLog } from '../wiki/service.js'

export const wikiAppendLogTool = createTool({
  id: 'wiki_append_log',
  description: 'Appende una voce formattata a wiki/log.md. La voce deve seguire il formato: "## [YYYY-MM-DD] <tipo> | <titolo>".',
  inputSchema: z.object({
    entry: z.string().describe('Testo della voce di log da appendere'),
  }),
  execute: async ({ entry }) => {
    appendLog(entry)
    return { success: true }
  },
})
