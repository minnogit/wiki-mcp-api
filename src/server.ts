import { MCPServer } from '@mastra/mcp'
import type { WikiService } from './wiki/service.js'
import { DEFAULT_WIKI_NAME } from './config.js'
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

// Tool di sola lettura: sono gli unici esposti al server HTTP remoto (src/http.ts).
// I tool di scrittura (wikiWritePage, wikiAppendLog) restano disponibili solo via stdio locale.
// Questa è una scelta di design deliberata, non solo lo stato attuale: la scrittura via
// stdio presuppone un clone locale della wiki, che dà gratis due garanzie che il codice
// non fornisce altrimenti — attribuzione (il commit è di chi esegue l'agente, con la sua
// identità git) e un checkpoint umano (il diff viene rivisto prima del commit). Un client
// HTTP/remoto non ha né l'uno né l'altro: il lock su singolo file (proper-lockfile) evita
// solo la corruzione concorrente, non risolve conflitti tra scritture di utenti diversi, e
// nessun tool esegue mai commit. Se in futuro si vuole abilitare scrittura remota, queste
// garanzie vanno reintrodotte esplicitamente (auth per-utente, attribuzione, strategia di
// commit/review) prima di spostare un tool di scrittura in buildRemoteServer.
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
function buildInstructions(domain: string | undefined, { sources }: { sources: boolean }): string {
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

// Server completo (lettura + scrittura), esposto solo via stdio locale (src/stdio.ts).
export function buildServer(svc: WikiService): MCPServer {
  const sources = svc.context.rawDir !== undefined
  const { suffixId, suffixName } = labels(svc)
  return new MCPServer({
    id: `wiki-mcp${suffixId}`,
    name: `LLM Wiki MCP Server${suffixName}`,
    version: '0.1.0',
    description: 'Ponte MCP tra agenti AI e una wiki di dominio in markdown',
    instructions: buildInstructions(svc.context.domain, { sources }),
    tools: {
      ...wikiReadTools(svc),
      ...(sources ? sourceTools(svc) : {}),
      ...writeTools(svc),
    },
  })
}

// Server di sola lettura, esposto via HTTP per l'accesso remoto (src/http.ts), uno per wiki.
// Non include wikiWritePage/wikiAppendLog: la scrittura resta possibile solo in locale.
// Senza MCP_HTTP_EXPOSE_RAW (o se la wiki non ha rawDir) non include nemmeno i tool sulle
// sorgenti. `exposeRaw` è esplicito per i test; di default si legge l'ambiente.
export function buildRemoteServer(
  svc: WikiService,
  { exposeRaw = rawOverHttp() }: { exposeRaw?: boolean } = {},
): MCPServer {
  const sources = exposeRaw && svc.context.rawDir !== undefined
  const { suffixId, suffixName } = labels(svc)
  return new MCPServer({
    id: `wiki-mcp-readonly${suffixId}`,
    name: `LLM Wiki MCP Server (read-only)${suffixName}`,
    version: '0.1.0',
    description: 'Ponte MCP di sola lettura verso una wiki di dominio in markdown',
    instructions: `${buildInstructions(svc.context.domain, { sources })}\n\n${
      sources
        ? 'Questa istanza è di sola lettura: wikiWritePage e wikiAppendLog non sono disponibili qui.'
        : 'Questa istanza è di sola lettura e serve solo le pagine della wiki: wikiWritePage, wikiAppendLog e i tool sulle sorgenti (wikiListRaw, wikiReadRaw, wikiRawDiff, wikiChecksum) non sono disponibili qui.'
    }`,
    tools: {
      ...wikiReadTools(svc),
      ...(sources ? sourceTools(svc) : {}),
    },
  })
}
