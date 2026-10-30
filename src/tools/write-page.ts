import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { WikiService } from '../wiki/service.js'

export const wikiWritePageTool = (svc: WikiService) =>
  createTool({
    id: 'wikiWritePage',
    description:
      'Crea o aggiorna una pagina nella wiki. Scrive SOLO in wiki/, mai in raw/. Il path è relativo alla directory wiki, es. "concetti/nuova-pagina.md". ' +
      'Il frontmatter YAML è validato: tipo (uno tra concetto|soggetto|procedura|normativa|entita|analisi), tags (almeno uno), fonti (array, anche vuoto), ' +
      'aggiornato (formato YYYY-MM-DD) e stato (bozza|stabile|da-rivedere) sono tutti obbligatori, altrimenti la scrittura fallisce con un errore descrittivo. ' +
      'Opzionali, per i permessi di lettura: visibilita (pubblica|interna|riservata) e gruppi (lista di nomi di gruppo, contano solo con riservata). ' +
      'Eccezione: index.md, log.md, sources.md e overview.md nella radice della wiki non richiedono frontmatter (se dichiarano visibilita/gruppi, quei due campi sono validati).',
    inputSchema: z.object({
      path: z.string().describe('Path relativo alla wiki dir, es. "concetti/verbale.md"'),
      content: z
        .string()
        .describe('Contenuto Markdown completo della pagina, incluso frontmatter YAML'),
    }),
    execute: async ({ path, content }) => {
      try {
        const warnings = await svc.writePage(path, content)
        return { success: true, path, ...(warnings.length > 0 ? { warnings } : {}) }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    },
  })
