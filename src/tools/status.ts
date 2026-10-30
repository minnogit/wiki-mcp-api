import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { WikiService } from '../wiki/service.js'

export const wikiStatusTool = (svc: WikiService) =>
  createTool({
    id: 'wikiStatus',
    description:
      "Restituisce lo stato della wiki: numero totale di pagine, distribuzione per tipo e per stato, data ultimo aggiornamento. La data è il frontmatter `aggiornato` più recente; per le pagine senza frontmatter valido (es. log.md) si usa la data di modifica del file. Se la wiki sta dentro un checkout git, il campo opzionale `source` riporta la freschezza della copia servita: `commit` (SHA breve del HEAD), `commitDate` (data ISO del commit) e `syncedAt` (ora ISO dell'ultimo `git fetch`/`pull`, null se mai eseguito). Se la wiki non è in un repo git o git non è disponibile, `source` è assente.",
    inputSchema: z.object({}),
    execute: async () => svc.getStatus(),
  })
