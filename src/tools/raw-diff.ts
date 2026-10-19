import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { rawDiff } from '../wiki/service.js'

export const wikiRawDiffTool = createTool({
  id: 'wikiRawDiff',
  description:
    'Mostra cosa è cambiato in un file di raw/ rispetto alla versione già ingerita, via git (sola lettura). ' +
    "Da usare nell'INGEST quando wikiListRaw segnala un checksum diverso da quello in wiki/sources.md: leggi il diff PRIMA di aggiornare le pagine wiki, " +
    'così aggiorni solo ciò che è davvero cambiato senza riscrivere da zero. ' +
    '`sinceChecksum` è il checksum registrato in wiki/sources.md per quel file: il tool trova da solo il commit in cui il file aveva quel contenuto e restituisce il diff fino allo stato attuale. ' +
    "Senza `sinceChecksum` mostra l'ultima modifica del file (non committata, altrimenti l'ultimo commit che l'ha toccato): è un'euristica, non il delta dall'ultimo ingest. " +
    "I PDF sono diffabili se la wiki li mappa in .gitattributes (`*.pdf diff=pdf`) e sulla macchina del server c'è `pdftotext` (poppler-utils). " +
    'Esiti senza diff testuale: "unchanged", "binary" (usa solo il checksum), "untracked" (file non versionato), "no-git" (raw/ non è in un repo git), ' +
    '"baseline-not-found" (nessun commit ha quel checksum, la versione ingerita non fu mai committata): in questi casi ripiega su wikiReadRaw e sul confronto per checksum.',
  inputSchema: z.object({
    filename: z
      .string()
      .describe(
        'Path relativo del file in raw/ (anche in sottocartelle), es. "verbali/2026-01.md"',
      ),
    sinceChecksum: z
      .string()
      .optional()
      .describe(
        "Checksum (12 caratteri esadecimali) registrato in wiki/sources.md per questo file all'ultimo ingest",
      ),
  }),
  execute: async ({ filename, sinceChecksum }) => {
    try {
      return { filename, ...(await rawDiff(filename, sinceChecksum)) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
})
