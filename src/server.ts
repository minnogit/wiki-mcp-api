import { MCPServer } from '@mastra/mcp'
import type { WikiService } from './wiki/service.js'
import { DEFAULT_WIKI_NAME } from './config.js'
import { auditTools, type ExecutableTool } from './audit.js'
import { METRIC } from './metrics.js'
import { telemetry as processTelemetry, type Telemetry } from './telemetry.js'
import { wikiSearchTool } from './tools/search.js'
import { wikiReadPageTool } from './tools/read-page.js'
import { wikiListPagesTool } from './tools/list-pages.js'
import { wikiWritePageTool } from './tools/write-page.js'
import { wikiAppendLogTool } from './tools/append-log.js'
import { wikiListRawTool, wikiReadRawTool } from './tools/read-raw.js'
import { wikiRawDiffTool } from './tools/raw-diff.js'
import { wikiChecksumTool } from './tools/checksum.js'
import { wikiGraphTool } from './tools/graph.js'
import { wikiStatusTool } from './tools/status.js'
import { wikiProposePageTool } from './tools/propose-page.js'
import type { Proposer } from './proposals.js'

// Tool di sola lettura: sono gli unici esposti al server HTTP remoto (src/http.ts) senza
// ulteriore configurazione. I tool di scrittura immediata (wikiWritePage, wikiAppendLog) restano disponibili solo via stdio
// locale. Questa è una scelta di design deliberata: la scrittura via stdio presuppone un clone
// locale della wiki, che dà gratis due garanzie che il codice non fornisce altrimenti —
// attribuzione (il commit è di chi esegue l'agente, con la sua identità git) e un checkpoint
// umano (il diff viene rivisto prima del commit). Un client HTTP/remoto non le ha, quindi NON
// scrive mai sulla wiki servita: il lock su singolo file (proper-lockfile) evita solo la
// corruzione concorrente, non risolve conflitti tra utenti diversi, e nessun tool esegue commit
// sul clone servito.
//
// La scrittura remota esiste, ma solo come proposta (wikiProposePage, src/proposals.ts), montata
// in buildRemoteServer solo per le wiki che configurano `proposals`, e le tre garanzie sono
// riprodotte così:
// - attribuzione: l'identità per-utente del token (Principal, permesso esplicito `propose`) finisce
//   nel trailer `Proposed-by` del commit e nel corpo della PR (il commit è del bot, ma il
//   proponente è sempre riconoscibile, e nell'audit);
// - checkpoint umano: il tool apre una pull request e si ferma lì; la rivede una persona, che è
//   anche l'unica a poterla unire (branch protection/CODEOWNERS sul repo della wiki);
// - strategia di commit: un branch per proposta (`proposta/...`), un commit del bot, nessun
//   merge automatico; il sync esistente (deploy/) porta poi la modifica al server.
// Un tool di scrittura nuovo non va spostato in buildRemoteServer: o passa da questo flusso
// (PR rivista da una persona), o resta solo su stdio.
//
// I tool di sola lettura si dividono in due gruppi. Quelli sulle pagine leggono solo wiki/.
// Quelli sulle sorgenti toccano raw/: servono all'INGEST, che è un lavoro locale, e da remoto
// darebbero accesso a tutto ciò che sta in rawDir (bozze comprese, se la cartella le contiene)
// e alla sua storia git (wikiRawDiff). wikiChecksum è tra le sorgenti perché controlla anche
// raw/: senza i tool di lettura resterebbe un modo per sapere se un file esiste e qual è il suo hash.
//
// Ogni wiki ha il proprio service (e quindi i propri tool, che sono factory sul service) e il
// proprio MCPServer: i tool NON prendono un parametro `wiki`, è l'endpoint a scegliere la wiki.
// Una wiki senza rawDir non monta i tool sulle sorgenti in nessun trasporto.
function wikiReadTools(svc: WikiService) {
  return {
    wikiSearch: wikiSearchTool(svc),
    wikiReadPage: wikiReadPageTool(svc),
    wikiListPages: wikiListPagesTool(svc),
    wikiGraph: wikiGraphTool(svc),
    wikiStatus: wikiStatusTool(svc),
  }
}

function sourceTools(svc: WikiService) {
  return {
    wikiListRaw: wikiListRawTool(svc),
    wikiReadRaw: wikiReadRawTool(svc),
    wikiRawDiff: wikiRawDiffTool(svc),
    wikiChecksum: wikiChecksumTool(svc),
  }
}

function writeTools(svc: WikiService) {
  return {
    wikiWritePage: wikiWritePageTool(svc),
    wikiAppendLog: wikiAppendLogTool(svc),
  }
}

// L'accesso HTTP serve di default solo le pagine. MCP_HTTP_EXPOSE_RAW=true (valore esatto,
// niente "1" o "TRUE") monta anche i tool sulle sorgenti: va scelto solo se la cartella raw
// di ogni wiki contiene materiale che può essere letto da chiunque abbia il token.
export function rawOverHttp(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_HTTP_EXPOSE_RAW === 'true'
}

// Il server è domain-agnostic: la riga che descrive *quale* dominio documenta la
// wiki collegata arriva dal contesto (WIKI_DOMAIN, o `domain` in WIKI_CONFIG). Senza
// di essa il client riceverebbe la descrizione del dominio sbagliato non appena si
// serve una seconda wiki con lo stesso binario.
const DEFAULT_DOMAIN_LINE =
  'Questa wiki documenta un dominio di conoscenza mantenuto come pagine markdown. Il dominio specifico è descritto nel CLAUDE.md della wiki collegata (accanto a wiki/).'

// I nomi qui devono combaciare con le CHIAVI degli oggetti `tools` sopra (camelCase):
// è la chiave, non il campo `id` del tool, a diventare il nome esposto via MCP.
// `sources` dice se i tool sulle sorgenti sono disponibili: senza, l'INGEST e le regole su raw/
// non vanno descritti al client, che non potrebbe seguirli.
function buildInstructions(
  domain: string | undefined,
  { sources, proposals = false }: { sources: boolean; proposals?: boolean },
): string {
  return [
    domain ?? DEFAULT_DOMAIN_LINE,
    '',
    'Workflow principali:',
    ...(sources
      ? [
          '- INGEST: usa wikiListRaw, wikiReadRaw, wikiRawDiff, wikiChecksum, wikiWritePage, wikiAppendLog. Se un raw già ingerito ha un checksum diverso da quello in sources.md, chiama wikiRawDiff (con sinceChecksum = checksum registrato in sources.md per quel file) e aggiorna le pagine in base al delta, senza riscrivere da zero; con esiti unchanged/binary/untracked/no-git/baseline-not-found ripiega su checksum e wikiReadRaw',
        ]
      : []),
    '- QUERY: leggi prima wikiReadPage("index") per individuare le pagine candidate, poi usa wikiSearch, wikiReadPage, wikiListPages',
    '- LINT: usa wikiListPages, wikiGraph, wikiStatus',
    '',
    'Regole:',
    '- wikiWritePage scrive SOLO in wiki/, mai in raw/',
    '- wikiWritePage valida il frontmatter (tipo/tags/fonti/aggiornato/stato); index.md, log.md, sources.md e overview.md ne sono esenti',
    ...(sources ? ['- wikiReadRaw e wikiRawDiff sono read-only'] : []),
    '- I path delle pagine sono relativi alla wiki dir (es. "concetti/verbale.md")',
    ...(proposals
      ? [
          "- wikiProposePage NON modifica la wiki: apre una pull request nel repository, che una persona rivede e unisce; la modifica compare qui solo dopo il merge e la sincronizzazione. Usalo quando devi creare o correggere una pagina: rileggi prima la pagina (wikiReadPage), proponi il contenuto COMPLETO con frontmatter valido e una motivazione breve. Riporta all'utente l'URL della PR (prUrl) e dì che è in attesa di revisione, non che la modifica è stata applicata",
          '- con wikiProposePage non puoi cambiare visibilita/gruppi di una pagina esistente, né proporre pagine riservate che non puoi leggere; i file index.md, log.md, sources.md e overview.md non sono proponibili; ci sono limiti di frequenza per utente',
        ]
      : []),
    '- alcune pagine possono essere riservate ad altri gruppi (frontmatter visibilita/gruppi): se non sono permesse al tuo accesso non compaiono in nessun tool e wikiReadPage risponde come per una pagina inesistente',
  ].join('\n')
}

// Le wiki con nome diverso da `default` aggiungono il nome a id e titolo, per distinguerle
// quando un client ne collega più d'una; `default` resta com'era prima del multi-wiki.
function labels(svc: WikiService): { suffixId: string; suffixName: string } {
  const { name } = svc.context
  return name === DEFAULT_WIKI_NAME
    ? { suffixId: '', suffixName: '' }
    : { suffixId: `-${name}`, suffixName: ` [${name}]` }
}

// Ogni tool registrato passa da `auditTools`: audit e metriche sono qui, in un punto solo, e i file
// dei tool restano wrapper sottili. Il nome usato è la chiave dell'oggetto (il nome MCP).
function audited<T extends Record<string, ExecutableTool>>(
  svc: WikiService,
  tools: T,
  tel: Telemetry,
): T {
  return auditTools(tools, {
    wiki: svc.context.name,
    auditor: tel.auditor,
    metrics: tel.metrics,
    queryMaxChars: tel.queryMaxChars,
  })
}

/** Espone il numero di pagine in cache come gauge `wiki_mcp_wiki_pages{wiki}`, calcolato allo scrape. */
export function registerWikiGauge(svc: WikiService, tel: Telemetry = processTelemetry()): void {
  tel.metrics.addGauge(
    METRIC.wikiPages,
    'Pagine della wiki (dalla cache del service)',
    async () => [{ labels: { wiki: svc.context.name }, value: (await svc.getAllPages()).length }],
  )
}

// Server completo (lettura + scrittura), esposto solo via stdio locale (src/stdio.ts).
export function buildServer(svc: WikiService, tel: Telemetry = processTelemetry()): MCPServer {
  const sources = svc.context.rawDir !== undefined
  const { suffixId, suffixName } = labels(svc)
  return new MCPServer({
    id: `wiki-mcp${suffixId}`,
    name: `LLM Wiki MCP Server${suffixName}`,
    version: '0.1.0',
    description: 'Ponte MCP tra agenti AI e una wiki di dominio in markdown',
    instructions: buildInstructions(svc.context.domain, { sources }),
    tools: audited(
      svc,
      {
        ...wikiReadTools(svc),
        ...(sources ? sourceTools(svc) : {}),
        ...writeTools(svc),
      },
      tel,
    ),
  })
}

// Server di sola lettura, esposto via HTTP per l'accesso remoto (src/http.ts), uno per wiki.
// Non include wikiWritePage/wikiAppendLog: la scrittura immediata resta possibile solo in locale.
// Con `proposer` (la wiki ha `proposals` e il token GitHub) monta anche wikiProposePage, che non
// scrive ma apre una pull request da rivedere (vedi il commento di design in cima).
// Senza MCP_HTTP_EXPOSE_RAW (o se la wiki non ha rawDir) non include nemmeno i tool sulle
// sorgenti. `exposeRaw` è esplicito per i test; di default si legge l'ambiente.
export function buildRemoteServer(
  svc: WikiService,
  {
    exposeRaw = rawOverHttp(),
    telemetry: tel = processTelemetry(),
    proposer,
  }: { exposeRaw?: boolean; telemetry?: Telemetry; proposer?: Proposer } = {},
): MCPServer {
  const sources = exposeRaw && svc.context.rawDir !== undefined
  const { suffixId, suffixName } = labels(svc)
  return new MCPServer({
    id: `wiki-mcp-readonly${suffixId}`,
    name: `LLM Wiki MCP Server (read-only)${suffixName}`,
    version: '0.1.0',
    description: 'Ponte MCP di sola lettura verso una wiki di dominio in markdown',
    instructions: `${buildInstructions(svc.context.domain, { sources, proposals: proposer !== undefined })}\n\n${
      sources
        ? 'Questa istanza è di sola lettura: wikiWritePage e wikiAppendLog non sono disponibili qui.'
        : 'Questa istanza è di sola lettura e serve solo le pagine della wiki: wikiWritePage, wikiAppendLog e i tool sulle sorgenti (wikiListRaw, wikiReadRaw, wikiRawDiff, wikiChecksum) non sono disponibili qui.'
    }${
      proposer
        ? ' Le modifiche si possono solo proporre con wikiProposePage (pull request da rivedere), mai applicare direttamente.'
        : ''
    }`,
    tools: audited(
      svc,
      {
        ...wikiReadTools(svc),
        ...(sources ? sourceTools(svc) : {}),
        ...(proposer ? { wikiProposePage: wikiProposePageTool(proposer) } : {}),
      },
      tel,
    ),
  })
}
