import { randomBytes } from 'node:crypto'
import matter from 'gray-matter'
import { annotateAudit, markDenied, type DeniedReason } from './audit.js'
import { canPropose, currentPrincipal, type Principal } from './auth.js'
import { ConfigError, type ProposalsConfig } from './config.js'
import { GitHubError, createGitHubClient, type GitHubApi, type GitHubErrorKind } from './github.js'
import { FailureRateLimiter } from './http-auth.js'
import { shortError, type Logger } from './log.js'
import { METRIC, type ProposalOutcome } from './metrics.js'
import {
  commitMessage,
  oneLine,
  prBody,
  prTitle,
  slug,
  type ProposalMeta,
} from './proposal-text.js'
import { telemetry as processTelemetry, type Telemetry } from './telemetry.js'
import { canWrite, parseAccess, accessSignature, ADMIN_GROUP } from './wiki/access.js'
import { isReservedRootFile, validateFrontmatter, type WikiService } from './wiki/service.js'

// Scrittura remota con revisione umana. Un client remoto non scrive mai sulla wiki servita:
// `propose` crea su GitHub un branch con il file e apre una pull request; il merge lo fa una
// persona e il sync esistente (deploy/) porta la modifica al server. Questo modulo non fa mai
// merge e non tocca il filesystem della wiki (la legge soltanto, tramite il service, per
// sapere se la pagina esiste e per i permessi).

/** Prefisso dei branch creati dal tool: serve anche a contare le PR aperte dal bot. */
export const BRANCH_PREFIX = 'proposta/'

/**
 * Messaggio unico per ogni «non consentito» legato al percorso: percorso non valido, file
 * riservato, pagina esistente ma non visibile al proponente, pagina presente sul repo ma non
 * ancora sul server. Deve restare identico, parola per parola, in tutti questi casi: il
 * proponente non deve poter distinguere una pagina nascosta da un percorso vietato.
 */
export const PATH_DENIED_MESSAGE = 'Percorso non consentito.'

const PROPOSE_DENIED_MESSAGE = 'Non hai il permesso di proporre modifiche a questa wiki.'

export interface ProposeInput {
  path: string
  content: string
  rationale?: string
  title?: string
}

export interface ProposeSuccess {
  prUrl: string
  prNumber: number
  branch: string
  action: 'create' | 'update'
  warnings?: string[]
}

export interface ProposeFailure {
  success: false
  error: string
}

export type ProposeResult = ProposeSuccess | ProposeFailure

export interface Proposer {
  propose(input: ProposeInput): Promise<ProposeResult>
  /** Parametri utili a descrivere il tool al client. */
  readonly limits: { maxContentChars: number; maxRationaleChars: number }
}

export interface ProposerOptions {
  svc: WikiService
  config: ProposalsConfig
  github: GitHubApi
  telemetry?: Telemetry
  /** Da dove leggere il principal; default `currentPrincipal` (letto a ogni chiamata). */
  principal?: () => Principal | undefined
  now?: () => number
}

/** Fallimento previsto: `denied` con motivo da vocabolario chiuso, oppure errore con messaggio sicuro. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly reason?: DeniedReason,
  ) {
    super(message)
  }
}

const GITHUB_MESSAGES: Record<GitHubErrorKind, string> = {
  auth: 'Il server non riesce ad accedere al repository delle proposte: avvisa chi lo gestisce.',
  'not-found': 'Repository o branch delle proposte non trovato: avvisa chi gestisce il server.',
  conflict: 'La pagina è cambiata nel frattempo: rileggila e riproponi la modifica.',
  validation: 'GitHub ha rifiutato la proposta.',
  'rate-limit': 'GitHub sta limitando le richieste: riprova più tardi.',
  timeout: 'GitHub non ha risposto in tempo: riprova più tardi.',
  network: 'Il server non riesce a raggiungere GitHub: riprova più tardi.',
  server: 'GitHub ha avuto un errore: riprova più tardi.',
  protocol: 'Risposta inattesa da GitHub.',
}

// --- validazione del percorso -----------------------------------------------------------------

const MAX_PATH_CHARS = 200
const PATH_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\:*?"<>|]/

/**
 * Percorso proponibile: relativo alla wiki, `.md`, senza traversal, senza segmenti nascosti,
 * senza i file riservati della radice. Restituisce il motivo del rifiuto o `undefined` se va bene.
 * Lo stesso controllo vale per creare e modificare.
 */
export function pathProblem(relPath: string): string | undefined {
  if (relPath.length === 0 || relPath.length > MAX_PATH_CHARS) return 'lunghezza'
  if (PATH_FORBIDDEN_CHARS.test(relPath)) return 'caratteri'
  if (!relPath.endsWith('.md')) return 'estensione'
  if (relPath.startsWith('/')) return 'assoluto'
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return 'segmento'
    if (seg.startsWith('.')) return 'nascosto'
    if (seg.length > 120) return 'lunghezza'
  }
  if (segments[segments.length - 1] === '.md') return 'nome'
  if (isReservedRootFile(relPath)) return 'riservato'
  return undefined
}

// --- limiti -----------------------------------------------------------------------------------

function gitHubMessage(e: unknown): string {
  return e instanceof GitHubError ? GITHUB_MESSAGES[e.kind] : 'Errore imprevisto nella proposta.'
}

function timestamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

/** Nome del branch: `proposta/<utente>-<pagina>-<timestamp>-<4 hex>` (l'ultimo evita collisioni nello stesso secondo). */
export function branchName(user: string, relPath: string, now: number): string {
  return `${BRANCH_PREFIX}${slug(user, 20)}-${slug(relPath.replace(/\//g, '-'), 40)}-${timestamp(now)}-${randomBytes(2).toString('hex')}`
}

// --- il proponente ----------------------------------------------------------------------------

export function createProposer(options: ProposerOptions): Proposer {
  const { svc, config, github } = options
  const tel = options.telemetry ?? processTelemetry()
  const logger: Logger = tel.logger
  const principalNow = options.principal ?? currentPrincipal
  const now = options.now ?? Date.now
  const wiki = svc.context.name
  // Stesso limitatore a finestra fissa dei tentativi di accesso falliti (src/http-auth.ts): qui la
  // chiave è il principal e ogni tentativo che supera il permesso `propose` conta come uno.
  const limiter = new FailureRateLimiter({
    maxFailures: config.rateLimitMax,
    windowMs: config.rateLimitWindowSeconds * 1000,
    now,
  })

  const count = (outcome: ProposalOutcome): void =>
    tel.metrics.inc(
      METRIC.proposals,
      { wiki, outcome },
      'Proposte di modifica per wiki ed esito (created|denied|error)',
    )

  function deny(reason: DeniedReason, message: string): never {
    throw new Refusal(message, reason)
  }

  async function run(input: ProposeInput): Promise<ProposeSuccess> {
    // 1. chi è, e ha il permesso di proporre su questa wiki?
    const principal = principalNow()
    if (!principal || !canPropose(principal, wiki)) {
      deny('propose-not-allowed', PROPOSE_DENIED_MESSAGE)
    }
    const isAdmin = principal.groups.includes(ADMIN_GROUP)

    // 1b. rate limit per principal (prima di tutto il resto: anche i rifiuti sul percorso
    // contano, altrimenti la proposta sarebbe un oracolo gratuito sull'esistenza delle pagine)
    const retry = limiter.retryAfterSeconds(principal.id)
    if (retry > 0) {
      deny(
        'rate-limited',
        `Troppe proposte in poco tempo: riprova tra circa ${Math.ceil(retry / 60)} minuti.`,
      )
    }
    limiter.recordFailure(principal.id)

    // 2. percorso
    const relPath = input.path
    if (pathProblem(relPath) !== undefined) deny('path-not-allowed', PATH_DENIED_MESSAGE)

    // 3. dimensioni
    if (input.content.trim() === '') deny('invalid-content', 'Il contenuto è vuoto.')
    if (input.content.length > config.maxContentChars) {
      deny(
        'invalid-content',
        `Il contenuto è troppo grande (massimo ${config.maxContentChars} caratteri).`,
      )
    }
    if ((input.rationale?.length ?? 0) > config.maxRationaleChars) {
      deny(
        'invalid-content',
        `La motivazione è troppo lunga (massimo ${config.maxRationaleChars} caratteri).`,
      )
    }

    // 4. frontmatter: la stessa validazione di writePage
    let warnings: string[]
    let incoming: ReturnType<typeof parseAccess>
    try {
      warnings = validateFrontmatter(relPath, input.content)
      incoming = parseAccess(matter(input.content).data)
    } catch (e) {
      // il messaggio descrive il contenuto del proponente stesso: gli si mostra, ma breve
      deny(
        'invalid-content',
        oneLine(e instanceof Error ? e.message : 'Frontmatter non valido.', 400),
      )
    }

    // 5. la pagina esiste? chi la scrive ne ha diritto?
    const target = await svc.proposalTarget(relPath)
    // Esiste ma non è scrivibile: stessa risposta di un percorso vietato (nessuna conferma che
    // la pagina esista); solo l'audit sa il motivo.
    if (target.kind === 'forbidden') deny(target.reason, PATH_DENIED_MESSAGE)

    // 6. visibilità: le regole su `visibilita`/`gruppi`
    if (target.kind === 'existing') {
      // la modifica dei campi di accesso di una pagina esistente è solo per admin
      if (!isAdmin && accessSignature(target.access) !== accessSignature(incoming)) {
        deny(
          'visibility',
          'Solo un admin può cambiare visibilita o gruppi di una pagina esistente: lasciali come sono.',
        )
      }
    }
    if (!canWrite(incoming, principal)) {
      deny(
        'visibility',
        'Una pagina riservata deve indicare tra i gruppi almeno uno dei tuoi (oppure serve un admin).',
      )
    }

    // 7. da qui si parla con GitHub
    const repoPath = `${config.pathPrefix}${relPath}`
    let branch: string | undefined
    let branchCreated = false
    try {
      const open = await github.countOpenPulls(BRANCH_PREFIX, config.maxOpenPulls)
      if (open >= config.maxOpenPulls) {
        deny(
          'open-prs-limit',
          'Ci sono già troppe proposte in attesa di revisione: riprova quando saranno state riviste.',
        )
      }

      const baseSha = await github.getBranchSha(config.baseBranch)
      const remote = await github.getFile(repoPath, baseSha)
      // Il clone servito e il repo possono essere sfasati (sync in ritardo): una pagina che sul
      // repo c'è e sul server no non si può controllare, quindi non si accetta. Stessa risposta
      // di «percorso non consentito».
      if (target.kind === 'missing' && remote) deny('not-synced', PATH_DENIED_MESSAGE)
      const action: 'create' | 'update' = remote ? 'update' : 'create'
      if (remote && remote.content === input.content) {
        deny(
          'invalid-content',
          'Il contenuto è identico alla versione attuale: nessuna modifica da proporre.',
        )
      }

      branch = branchName(principal.user, relPath, now())
      const meta: ProposalMeta = {
        user: principal.user,
        principalId: principal.id,
        wiki,
        path: relPath,
        action,
        title: input.title,
        rationale: input.rationale,
        maxRationaleChars: config.maxRationaleChars,
      }
      const bot = { name: config.botName, email: config.botEmail }

      await github.createBranch(branch, baseSha)
      branchCreated = true
      await github.putFile({
        path: repoPath,
        branch,
        message: commitMessage(meta),
        content: input.content,
        // concorrenza ottimistica: se il file è cambiato fra la lettura e la scrittura, GitHub
        // rifiuta (conflict) invece di sovrascrivere
        sha: remote?.sha,
        author: bot,
        committer: bot,
      })
      const pr = await github.createPull({
        title: prTitle(meta),
        body: prBody(meta),
        head: branch,
        base: config.baseBranch,
      })
      if (config.labels.length > 0) {
        // la PR esiste già: non si tocca il branch per un'etichetta mancata
        await github.addLabels(pr.number, config.labels).catch((e: unknown) => {
          logger.warn('proposal-labels-failed', {
            msg: 'etichette non applicate alla PR di proposta',
            wiki,
            prNumber: pr.number,
            error: shortError(e),
          })
        })
      }
      annotateAudit({ action, prUrl: pr.url, prNumber: pr.number, branch })
      return {
        prUrl: pr.url,
        prNumber: pr.number,
        branch,
        action,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } catch (e) {
      if (branch) annotateAudit({ branch })
      // ripulitura best effort del branch rimasto orfano (la PR, se creata, non arriva qui)
      if (branch && branchCreated) {
        const orphan = branch
        await github.deleteBranch(orphan).then(
          () =>
            logger.info('proposal-cleanup', { msg: 'branch orfano rimosso', wiki, branch: orphan }),
          (err: unknown) =>
            logger.warn('proposal-cleanup-failed', {
              msg: 'branch orfano non rimosso: va tolto a mano',
              wiki,
              branch: orphan,
              error: shortError(err),
            }),
        )
      }
      throw e
    }
  }

  return {
    limits: {
      maxContentChars: config.maxContentChars,
      maxRationaleChars: config.maxRationaleChars,
    },
    async propose(input) {
      try {
        const result = await run(input)
        count('created')
        return result
      } catch (e) {
        if (e instanceof Refusal) {
          if (e.reason) markDenied(e.reason)
          count('denied')
          return { success: false, error: e.message }
        }
        // Errore vero (GitHub o altro): il dettaglio resta nel log del server, al client va una
        // frase fissa per tipo. Mai il token né il corpo della risposta di GitHub.
        count('error')
        logger.error('proposal-failed', {
          msg: 'proposta non riuscita',
          wiki,
          kind: e instanceof GitHubError ? e.kind : 'internal',
          status: e instanceof GitHubError ? e.status : undefined,
          error: shortError(e),
        })
        return { success: false, error: gitHubMessage(e) }
      }
    },
  }
}

// --- avvio ------------------------------------------------------------------------------------

/**
 * Legge il token GitHub dalla variabile d'ambiente indicata da `tokenEnv` e costruisce il
 * cliente. Lancia `ConfigError` se la variabile manca o è vuota: il server non deve avviarsi con
 * un tool che non potrà mai funzionare. Il token non viene mai incluso nel messaggio.
 */
export function createProposerFromConfig(
  svc: WikiService,
  env: NodeJS.ProcessEnv,
  telemetry: Telemetry,
): Proposer {
  const config = svc.context.proposals
  if (!config) throw new Error('la wiki non ha la configurazione proposals')
  const token = env[config.tokenEnv]?.trim()
  if (!token) {
    throw new ConfigError(
      `Wiki "${svc.context.name}": «proposals» è configurato ma la variabile d'ambiente ` +
        `${config.tokenEnv} (token GitHub) manca o è vuota.`,
    )
  }
  return createProposer({
    svc,
    config,
    telemetry,
    github: createGitHubClient({ apiUrl: config.apiUrl, token, repo: config.repo }),
  })
}
