import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { searchPages } from '../wiki/service.js'

export const wikiSearchTool = createTool({
  id: 'wiki_search',
  description:
    'Cerca pagine nella wiki per testo libero, tag, tipo o stato. Il testo libero usa ranking per rilevanza (peso su titolo > tag > contenuto, con IDF), non semplice substring match. ' +
    'Restituisce metadati senza il contenuto completo, ordinati per score decrescente quando `q` è presente. Quando `q` produce risultati, ogni voce include anche `snippet`: ' +
    'un estratto di contesto (~120 caratteri) intorno alla prima occorrenza del termine cercato, utile per valutare la pertinenza senza dover leggere la pagina intera con wiki_read_page. ' +
    'I risultati sono limitati a `topK` voci (default 10) per evitare output troppo grandi. ' +
    '**Uso via ToolSearch:** Dopo aver caricato con `ToolSearch`, invoca direttamente questo tool dal tool name completo (es. `mcp__wiki-mcp-api__wikiSearch`) — diventa immediatamente disponibile.',
  inputSchema: z.object({
    q: z.string().optional().describe('Testo da cercare in titolo e contenuto'),
    tag: z.string().optional().describe('Filtra per tag esatto'),
    tipo: z.enum(['concetto', 'soggetto', 'procedura', 'normativa', 'entita', 'analisi']).optional(),
    stato: z.enum(['bozza', 'stabile', 'da-rivedere']).optional(),
    topK: z.number().min(1).max(50).default(10).optional().describe('Numero massimo di risultati da restituire (default 10)'),
  }),
  execute: async (input) => searchPages(input),
})
