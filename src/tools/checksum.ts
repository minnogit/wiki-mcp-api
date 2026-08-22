import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fileChecksum } from '../wiki/service.js'

export const wikiChecksumTool = createTool({
  id: 'wiki_checksum',
  description: 'Calcola il checksum SHA256 (primi 12 caratteri) di un file wiki o raw. Usato dal workflow INGEST per deduplicare le sorgenti.',
  inputSchema: z.object({
    path: z.string().describe('Path del file relativo a wiki/ o raw/, es. "concetti/verbale.md" oppure "verbale.pdf"'),
  }),
  execute: async ({ path }) => {
    try {
      return { checksum: await fileChecksum(path), path }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
})
