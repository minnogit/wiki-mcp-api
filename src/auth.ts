import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { ConfigError } from './config.js'
import { TokenFileStore, type TokenEntry, type TokenFileOptions } from './token-file.js'

/**
 * Identità di chi fa la richiesta remota. È il contratto su cui poggiano audit, permessi per
 * pagina e scrittura remota: tool e service la leggono con `currentPrincipal()`, non la
 * ricevono come parametro (i tool non hanno argomenti «utente»: un agente non può dichiararsi
 * un altro).
 */
export interface Principal {
  /** Identificatore stabile della credenziale (id della voce nel file dei token, `legacy`). */
  readonly id: string
  /** Persona o servizio a cui appartiene la credenziale. */
  readonly user: string
  readonly groups: readonly string[]
  /** Nomi delle wiki abilitate, oppure `'*'` per tutte. */
  readonly wikis: readonly string[] | '*'
  /**
   * Wiki per cui può proporre modifiche (`wikiProposePage`): permesso esplicito, indipendente da
   * `wikis` (che dà la lettura). Vuoto = nessuna. Il token legacy non lo ha mai.
   */
  readonly propose: readonly string[] | '*'
}

/** Principal del token unico `MCP_HTTP_TOKEN`: accesso a tutte le wiki, nessun gruppo. */
export const LEGACY_PRINCIPAL: Principal = Object.freeze({
  id: 'legacy',
  user: 'legacy',
  groups: Object.freeze<string[]>([]),
  wikis: '*',
  propose: Object.freeze<string[]>([]),
})

const storage = new AsyncLocalStorage<Principal>()

/**
 * Esegue `fn` con `principal` come identità della richiesta corrente: tutto ciò che `fn` avvia
 * (anche in modo asincrono) la vede con `currentPrincipal()`. Solo il trasporto HTTP la chiama.
 */
export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  return storage.run(principal, fn)
}

/**
 * Identità della richiesta corrente. `undefined` significa «locale, fiducia piena»: è il caso
 * di stdio (processo avviato dall'utente stesso, nessun chiamante remoto). Un tool che deve
 * negare qualcosa a un remoto deve trattare `undefined` come permesso, non come anonimo.
 * Su HTTP il valore è sempre definito: una richiesta senza principal non arriva ai tool.
 */
export function currentPrincipal(): Principal | undefined {
  return storage.getStore()
}

/** La wiki `wiki` è tra quelle abilitate per il principal? */
export function canAccessWiki(principal: Principal, wiki: string): boolean {
  return principal.wikis === '*' || principal.wikis.includes(wiki)
}

/** Il principal può proporre modifiche alla wiki `wiki`? Serve il permesso `propose` E l'accesso alla wiki. */
export function canPropose(principal: Principal, wiki: string): boolean {
  return (
    canAccessWiki(principal, wiki) &&
    (principal.propose === '*' || principal.propose.includes(wiki))
  )
}

/** Esito di una verifica: il principal, oppure il motivo (solo per l'audit, mai per il client). */
export type AuthCheck =
  | { principal: Principal; reason?: undefined }
  | { principal?: undefined; reason: 'invalid-token' | 'expired-token' }

export interface Authenticator {
  /** Principal del token presentato, `undefined` se sconosciuto, revocato o scaduto. */
  authenticate(token: string): Principal | undefined
  /** Come `authenticate`, ma distingue token scaduto da sconosciuto/revocato (per l'audit). */
  check?(token: string): AuthCheck
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Hash nel formato del file dei token: `sha256:<hex>`. */
export function hashToken(token: string): string {
  return `sha256:${sha256(token).toString('hex')}`
}

function principalOf(entry: TokenEntry): Principal {
  return Object.freeze({
    id: entry.id,
    user: entry.user,
    groups: Object.freeze([...(entry.groups ?? [])]),
    wikis: entry.wikis === '*' ? '*' : Object.freeze([...entry.wikis]),
    propose: entry.propose === '*' ? '*' : Object.freeze([...(entry.propose ?? [])]),
  })
}

export interface AuthenticatorOptions {
  /** Token unico storico (`MCP_HTTP_TOKEN`): principal `legacy`. */
  legacyToken?: string
  /** Fonte delle voci per utente (con ricarica a caldo). */
  entries?: () => readonly TokenEntry[]
  now?: () => number
}

/**
 * Confronta il token presentato con tutte le credenziali note. L'hash sha256 del token ha
 * sempre la stessa lunghezza, quindi `timingSafeEqual` non lancia e non rivela nulla; il ciclo
 * non esce al primo riscontro, così il tempo non dipende da quale voce combacia. La scadenza si
 * valuta dopo il confronto.
 */
export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const now = options.now ?? Date.now
  const legacyDigest = options.legacyToken ? sha256(options.legacyToken) : undefined

  function check(token: string): AuthCheck {
    const digest = sha256(token)
    let matched: Principal | undefined
    let expired = false

    if (legacyDigest && timingSafeEqual(digest, legacyDigest)) matched = LEGACY_PRINCIPAL

    for (const entry of options.entries?.() ?? []) {
      const stored = Buffer.from(entry.tokenHash.slice('sha256:'.length), 'hex')
      if (timingSafeEqual(digest, stored) && matched === undefined) {
        if (entry.expiresAt !== undefined && now() >= Date.parse(entry.expiresAt)) {
          expired = true
        } else {
          matched = principalOf(entry)
        }
      }
    }
    if (expired) return { reason: 'expired-token' }
    return matched ? { principal: matched } : { reason: 'invalid-token' }
  }

  return { authenticate: (token) => check(token).principal, check }
}

export interface AuthSetup {
  authenticator: Authenticator
  /** Avvisi da mostrare all'avvio (non errori). */
  warnings: string[]
  /** Descrizione delle credenziali attive, per il log di avvio. */
  summary: string[]
}

/**
 * Costruisce l'autenticazione dall'ambiente: `MCP_HTTP_TOKENS_FILE` (token per utente) e/o
 * `MCP_HTTP_TOKEN` (legacy), validi insieme. Senza nessuno dei due lancia `ConfigError`: il
 * processo non deve mai partire aperto. Un file indicato ma illeggibile o invalido è un errore
 * di avvio; solo dopo l'avvio si tiene l'ultima versione valida.
 */
export function createAuthFromEnv(
  env: NodeJS.ProcessEnv,
  wikiNames: readonly string[],
  options: TokenFileOptions = {},
): AuthSetup {
  const legacyToken = env.MCP_HTTP_TOKEN || undefined
  const file = env.MCP_HTTP_TOKENS_FILE?.trim() || undefined
  if (!legacyToken && !file) {
    throw new ConfigError(
      'Nessuna credenziale configurata: imposta MCP_HTTP_TOKENS_FILE (token per utente) e/o ' +
        'MCP_HTTP_TOKEN (token unico). Obbligatorio per esporre il server in HTTP.',
    )
  }

  const warnings: string[] = []
  const summary: string[] = []
  let store: TokenFileStore | undefined
  if (file) {
    store = new TokenFileStore(file, wikiNames, options)
    summary.push(
      `token per utente da ${file} (${store.entries().length} voci, ricarica automatica)`,
    )
  }
  if (legacyToken) {
    summary.push('token legacy MCP_HTTP_TOKEN (accesso a tutte le wiki)')
    if (!store) {
      warnings.push(
        'Attivo solo il token legacy MCP_HTTP_TOKEN: un segreto unico, valido per tutte le wiki e ' +
          'non revocabile senza ruotarlo per tutti. Meglio i token per utente ' +
          '(MCP_HTTP_TOKENS_FILE, vedi README).',
      )
    }
  }

  return {
    authenticator: createAuthenticator({
      legacyToken,
      entries: store ? () => store.entries() : undefined,
      now: options.now,
    }),
    warnings,
    summary,
  }
}
