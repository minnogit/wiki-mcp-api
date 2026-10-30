// Cliente GitHub minimale per le proposte di modifica: solo le chiamate REST che servono
// (ref, branch, contents, pulls, labels), con `fetch` nativo e nessuna dipendenza. `apiUrl` è
// configurabile (GitHub Enterprise, e il finto server dei test).
//
// Regole di sicurezza:
// - il token sta solo nell'intestazione Authorization e non entra mai in un messaggio d'errore,
//   in un log o nell'URL;
// - gli errori verso l'esterno sono `GitHubError` con un `kind` chiuso: il messaggio per il client
//   MCP lo sceglie chi chiama in base al `kind`, mai dal corpo della risposta di GitHub;
// - ogni richiesta ha un timeout.

export const GITHUB_ERROR_KINDS = [
  'auth', // 401/403 senza limite di frequenza: token mancante, scaduto o senza permessi
  'not-found', // 404: repository o branch inesistente (o token che non lo vede)
  'conflict', // 409, o 422 su un file cambiato nel frattempo (sha non corrispondente)
  'validation', // altri 422: GitHub rifiuta la richiesta
  'rate-limit', // 429, o 403 con limite esaurito
  'timeout',
  'network',
  'server', // 5xx
  'protocol', // risposta inattesa
] as const
export type GitHubErrorKind = (typeof GITHUB_ERROR_KINDS)[number]

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    readonly status: number | undefined,
    /** Messaggio breve e senza segreti, solo per i log del server (mai per il client MCP). */
    message: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export interface GitHubOptions {
  /** Base dell'API, senza slash finale (es. `https://api.github.com`). */
  apiUrl: string
  token: string
  /** `proprietario/nome`. */
  repo: string
  /** Timeout di ogni richiesta, in ms. Default 10000. */
  timeoutMs?: number
  /** Per i test. */
  fetch?: typeof fetch
}

export interface GitIdentity {
  name: string
  email: string
}

export interface RemoteFile {
  /** SHA del blob, da passare alla successiva modifica (concorrenza ottimistica). */
  sha: string
  /** Contenuto decodificato (UTF-8). */
  content: string
}

export interface PullRequest {
  number: number
  url: string
}

/** Segmenti di un percorso, codificati uno a uno (gli `/` restano separatori). */
const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

/** Parte dell'interfaccia usata da `src/proposals.ts`: i test sostituiscono l'intero oggetto. */
export interface GitHubApi {
  getBranchSha(branch: string): Promise<string>
  getFile(path: string, ref: string): Promise<RemoteFile | null>
  createBranch(name: string, sha: string): Promise<void>
  putFile(args: {
    path: string
    branch: string
    message: string
    content: string
    sha?: string
    author: GitIdentity
    committer: GitIdentity
  }): Promise<void>
  createPull(args: {
    title: string
    body: string
    head: string
    base: string
  }): Promise<PullRequest>
  addLabels(number: number, labels: readonly string[]): Promise<void>
  deleteBranch(name: string): Promise<void>
  /** Numero di PR aperte la cui testa inizia con `headPrefix` (si ferma a `cap`). */
  countOpenPulls(headPrefix: string, cap: number): Promise<number>
}

export function createGitHubClient(options: GitHubOptions): GitHubApi {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const root = `${options.apiUrl.replace(/\/+$/, '')}/repos/${options.repo}`

  async function request(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    let res: Response
    try {
      res = await doFetch(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'wiki-mcp-api',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (e) {
      const name = (e as Error)?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GitHubError('timeout', undefined, `timeout dopo ${timeoutMs} ms su ${method}`)
      }
      throw new GitHubError('network', undefined, `richiesta ${method} non riuscita`)
    }
    if (res.status === 404 && allow404) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) throw errorFor(method, res, text)
    if (text === '') return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new GitHubError('protocol', res.status, 'risposta non JSON')
    }
  }

  // Il corpo dell'errore di GitHub ha un `message` utile per l'operatore: se ne tiene solo una
  // versione breve, destinata al log del server (il client MCP non la vede mai).
  function errorFor(method: string, res: Response, text: string): GitHubError {
    let detail = ''
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message
      if (typeof m === 'string') detail = m.split('\n')[0].slice(0, 120)
    } catch {
      // corpo non JSON: nessun dettaglio
    }
    const status = res.status
    const msg = `${method} -> ${status}${detail ? ` (${detail})` : ''}`
    const limited =
      status === 429 ||
      (status === 403 &&
        (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)))
    if (limited) return new GitHubError('rate-limit', status, msg)
    if (status === 401 || status === 403) return new GitHubError('auth', status, msg)
    if (status === 404) return new GitHubError('not-found', status, msg)
    if (status === 409) return new GitHubError('conflict', status, msg)
    if (status === 422) {
      const conflict = /does not match|sha/i.test(detail)
      return new GitHubError(conflict ? 'conflict' : 'validation', status, msg)
    }
    if (status >= 500) return new GitHubError('server', status, msg)
    return new GitHubError('protocol', status, msg)
  }

  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

  return {
    async getBranchSha(branch) {
      const data = obj(await request('GET', `/git/ref/heads/${encodePath(branch)}`))
      const sha = obj(data.object).sha
      if (typeof sha !== 'string') throw new GitHubError('protocol', undefined, 'ref senza sha')
      return sha
    },

    async getFile(path, ref) {
      const data = obj(
        await request(
          'GET',
          `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
          undefined,
          true,
        ),
      )
      if (Object.keys(data).length === 0) return null
      if (
        typeof data.sha !== 'string' ||
        typeof data.content !== 'string' ||
        data.type !== 'file'
      ) {
        // una cartella (array) o un oggetto non file: non è una pagina
        throw new GitHubError('protocol', undefined, 'il percorso non è un file')
      }
      return {
        sha: data.sha,
        content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8'),
      }
    },

    async createBranch(name, sha) {
      await request('POST', '/git/refs', { ref: `refs/heads/${name}`, sha })
    },

    async putFile({ path, branch, message, content, sha, author, committer }) {
      await request('PUT', `/contents/${encodePath(path)}`, {
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        branch,
        ...(sha === undefined ? {} : { sha }),
        author,
        committer,
      })
    },

    async createPull({ title, body, head, base }) {
      const data = obj(await request('POST', '/pulls', { title, body, head, base }))
      if (typeof data.number !== 'number' || typeof data.html_url !== 'string') {
        throw new GitHubError('protocol', undefined, 'PR senza numero o URL')
      }
      return { number: data.number, url: data.html_url }
    },

    async addLabels(number, labels) {
      await request('POST', `/issues/${number}/labels`, { labels })
    },

    async deleteBranch(name) {
      await request('DELETE', `/git/refs/heads/${encodePath(name)}`)
    },

    async countOpenPulls(headPrefix, cap) {
      const data = await request('GET', '/pulls?state=open&per_page=100')
      if (!Array.isArray(data)) throw new GitHubError('protocol', undefined, 'elenco PR inatteso')
      let count = 0
      for (const pr of data) {
        const ref = obj(obj(pr).head).ref
        if (typeof ref === 'string' && ref.startsWith(headPrefix)) count += 1
        if (count >= cap) break
      }
      return count
    },
  }
}
