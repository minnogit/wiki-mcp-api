import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { WikiService } from '../wiki/service.js'

export const wikiAppendLogTool = (svc: WikiService) =>
  createTool({
    id: 'wikiAppendLog',
    description:
      'Appende una voce formattata a wiki/log.md. La voce deve seguire il formato: "## [YYYY-MM-DD] <tipo> | <titolo>".',
    inputSchema: z.object({
      entry: z.string().describe('Testo della voce di log da appendere'),
    }),
    execute: async ({ entry }) => {
      await svc.appendLog(entry)
      return { success: true }
    },
  })
