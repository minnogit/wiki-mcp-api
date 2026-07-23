import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getGraph } from '../wiki/service.js'

export const wikiGraphTool = createTool({
  id: 'wiki_graph',
  description:
    'Restituisce il grafo dei wikilink [[...]] tra le pagine: { forward, reverse, orphans }. ' +
    'forward: slug -> slug delle pagine collegate (link in uscita). reverse: slug -> slug delle pagine che la collegano (link in entrata; ' +
    'può includere slug inesistenti se un wikilink punta a una pagina non ancora creata, utile per individuare link rotti). ' +
    'orphans: slug delle pagine senza alcun link in entrata, esclusi automaticamente index/log/sources/overview.',
  inputSchema: z.object({}),
  execute: async () => getGraph(),
})
