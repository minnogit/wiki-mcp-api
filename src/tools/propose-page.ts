import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { Proposer } from '../proposals.js'

// Wrapper sottile: tutta la logica (permessi, validazione, GitHub) è in src/proposals.ts. Esiste
// solo sul server remoto, per le wiki che configurano `proposals`.
export const wikiProposePageTool = (proposer: Proposer) =>
  createTool({
    id: 'wikiProposePage',
    description:
      'Propone la creazione o la modifica di una pagina della wiki: NON scrive nulla subito. Apre una pull request nel repository della wiki, che una persona rivedrà e potrà accettare o rifiutare; ' +
      'se accettata, la modifica arriva al server con la sincronizzazione successiva. Restituisce { prUrl, prNumber, branch, action } con action "create" o "update". ' +
      'Il path è relativo alla wiki, es. "concetti/nuova-pagina.md", solo .md (non index.md, log.md, sources.md, overview.md nella radice). ' +
      'content è la pagina COMPLETA con frontmatter valido (tipo, tags, fonti, aggiornato, stato; opzionali visibilita/gruppi). ' +
      'Per una modifica rileggi prima la pagina con wikiReadPage e riproponila intera. ' +
      'Non puoi cambiare visibilita/gruppi di una pagina esistente (solo gli admin) né proporre pagine che non puoi leggere. ' +
      `Limiti: contenuto fino a ${proposer.limits.maxContentChars} caratteri, motivazione fino a ${proposer.limits.maxRationaleChars}; ci sono limiti di frequenza per utente.`,
    inputSchema: z.object({
      path: z.string().describe('Path relativo alla wiki dir, es. "concetti/verbale.md"'),
      content: z
        .string()
        .describe('Contenuto Markdown completo della pagina, incluso frontmatter YAML'),
      rationale: z
        .string()
        .optional()
        .describe('Perché si propone la modifica: lo leggerà chi rivede la PR'),
      title: z
        .string()
        .optional()
        .describe('Titolo breve della PR (opzionale; di default "Nuova pagina: <path>")'),
    }),
    execute: (input) => proposer.propose(input),
  })
