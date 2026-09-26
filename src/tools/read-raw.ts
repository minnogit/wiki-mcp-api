import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { listRaw, readRaw } from '../wiki/service.js'

export const wikiListRawTool = createTool({
  id: 'wiki_list_raw',
  description:
    'Elenca ricorsivamente i file nella directory raw/ (sorgenti immutabili, incluse le sottocartelle) insieme al loro checksum SHA256 (12 caratteri) attuale. ' +
    'Il filename restituito è il path relativo a raw/ (es. "verbali/2026-01.md"), utile per distinguere file omonimi in sottocartelle diverse. ' +
    'Confronta i checksum con quelli registrati in wiki/sources.md per individuare in un colpo solo, senza chiamate ripetute a wiki_checksum, ' +
    'quali sorgenti sono nuove o sono cambiate rispetto all\'ultimo ingest (utile sia per INGEST sia per il controllo "pagine stale" del LINT).',
  inputSchema: z.object({}),
  execute: async () => listRaw(),})

export const wikiReadRawTool = createTool({
  id: 'wiki_read_raw',
  description:
    'Legge un file dalla directory raw/ (sola lettura). Il filename è il path relativo a raw/, ' +
    'può includere sottocartelle, es. "flusso_pagamenti.md" o "verbali/2026-01.md".',
  inputSchema: z.object({
    filename: z.string().describe('Path relativo del file in raw/ (anche in sottocartelle), es. "verbali/2026-01.md"'),
  }),
  execute: async ({ filename }) => {
    try {
      return { content: await readRaw(filename) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
})
