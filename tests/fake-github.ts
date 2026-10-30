import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// Finto server HTTP locale che emula il sottoinsieme delle API GitHub usato da src/github.ts
// (ref, creazione/cancellazione di branch, contents, pulls, labels). Ascolta su una porta
// effimera di 127.0.0.1: i test non contattano MAI la vera API di GitHub.

export interface FakePull {
  number: number
  title: string
  body: string
  head: string
  base: string
  labels: string[]
  html_url: string
}

export interface FakeCommit {
  branch: string
  path: string
  message: string
  author: { name: string; email: string }
  committer: { name: string; email: string }
}

export interface FakeRequest {
  method: string
  path: string
  authorization: string | undefined
  body: unknown
}

interface Failure {
  method: string
  pattern: RegExp
  status: number
  message?: string
  /** quante volte scattare (default sempre) */
  times?: number
  /** ritarda la risposta di questi ms (per i timeout) */
  delayMs?: number
}

export class FakeGitHub {
  readonly token: string
  readonly repo: string
  /** branch -> (percorso -> {sha, content}) */
  readonly branches = new Map<string, Map<string, { sha: string; content: string }>>()
  readonly branchCommit = new Map<string, string>()
  readonly pulls: FakePull[] = []
  readonly commits: FakeCommit[] = []
  readonly requests: FakeRequest[] = []
  private failures: Failure[] = []
  private server: http.Server | undefined
  url = ''

  constructor(opts: { token?: string; repo?: string } = {}) {
    this.token = opts.token ?? 'fakegh_FAKE_TOKEN_for_tests_only_0123456789'
    this.repo = opts.repo ?? 'acme/wiki'
    this.branches.set('main', new Map())
    this.branchCommit.set('main', sha1('init'))
  }

  /** Crea un file già presente su `main` (stato iniziale del repo). */
  seed(path: string, content: string, branch = 'main'): void {
    this.branches.get(branch)!.set(path, { sha: blobSha(content), content })
    this.branchCommit.set(branch, sha1(randomBytes(8).toString('hex')))
  }

  /** Fa fallire la prossima richiesta che combacia (metodo + percorso) con `status`. */
  failNext(
    method: string,
    pattern: RegExp,
    status: number,
    message = 'Boom',
    extra: Partial<Failure> = {},
  ): void {
    this.failures.push({ method, pattern, status, message, times: 1, ...extra })
  }

  failAlways(method: string, pattern: RegExp, status: number, extra: Partial<Failure> = {}): void {
    this.failures.push({ method, pattern, status, ...extra })
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    this.server = undefined
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf-8')
    const body: unknown = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'
    this.requests.push({
      method,
      path: url.pathname + url.search,
      authorization: req.headers.authorization,
      body,
    })
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(data === undefined ? '' : JSON.stringify(data))
    }

    const fail = this.failures.find((f) => f.method === method && f.pattern.test(url.pathname))
    if (fail) {
      if (fail.times !== undefined && --fail.times <= 0)
        this.failures.splice(this.failures.indexOf(fail), 1)
      if (fail.delayMs) await new Promise((r) => setTimeout(r, fail.delayMs))
      if (!res.destroyed)
        return send(fail.status, {
          message: fail.message ?? 'Boom',
          documentation_url: 'https://docs.github.com/secret-internal',
        })
      return
    }

    if (req.headers.authorization !== `Bearer ${this.token}`)
      return send(401, { message: 'Bad credentials' })
    const base = `/repos/${this.repo}`
    if (!url.pathname.startsWith(base + '/')) return send(404, { message: 'Not Found' })
    const rest = url.pathname.slice(base.length)
    let m: RegExpMatchArray | null

    if (method === 'GET' && (m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = this.branchCommit.get(decodeURIComponent(m[1]))
      return sha
        ? send(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } })
        : send(404, { message: 'Not Found' })
    }
    if (method === 'POST' && rest === '/git/refs') {
      const { ref, sha } = body as { ref: string; sha: string }
      const name = ref.replace(/^refs\/heads\//, '')
      if (this.branches.has(name)) return send(422, { message: 'Reference already exists' })
      const from = [...this.branchCommit].find(([, s]) => s === sha)?.[0]
      if (!from) return send(422, { message: 'Object does not exist' })
      this.branches.set(name, new Map(this.branches.get(from)))
      this.branchCommit.set(name, sha)
      return send(201, { ref, object: { sha } })
    }
    if (method === 'DELETE' && (m = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const name = decodeURIComponent(m[1])
      if (!this.branches.delete(name)) return send(422, { message: 'Reference does not exist' })
      this.branchCommit.delete(name)
      return send(204)
    }
    if (method === 'GET' && (m = rest.match(/^\/contents\/(.+)$/))) {
      const ref = url.searchParams.get('ref') ?? 'main'
      const name = [...this.branchCommit].find(([n, s]) => n === ref || s === ref)?.[0]
      const file = name ? this.branches.get(name)?.get(decodeURIComponent(m[1])) : undefined
      if (!file) return send(404, { message: 'Not Found' })
      return send(200, {
        type: 'file',
        sha: file.sha,
        content: Buffer.from(file.content)
          .toString('base64')
          .replace(/(.{60})/g, '$1\n'),
        encoding: 'base64',
      })
    }
    if (method === 'PUT' && (m = rest.match(/^\/contents\/(.+)$/))) {
      const p = body as {
        message: string
        content: string
        branch: string
        sha?: string
        author: FakeCommit['author']
        committer: FakeCommit['committer']
      }
      const files = this.branches.get(p.branch)
      if (!files) return send(404, { message: 'Branch not found' })
      const path = decodeURIComponent(m[1])
      const existing = files.get(path)
      if (existing && existing.sha !== p.sha)
        return send(409, { message: `${path} does not match ${existing.sha}` })
      if (!existing && p.sha)
        return send(422, { message: 'sha was supplied but file does not exist' })
      const content = Buffer.from(p.content, 'base64').toString('utf-8')
      files.set(path, { sha: blobSha(content), content })
      this.branchCommit.set(p.branch, sha1(randomBytes(8).toString('hex')))
      this.commits.push({
        branch: p.branch,
        path,
        message: p.message,
        author: p.author,
        committer: p.committer,
      })
      return send(existing ? 200 : 201, {
        content: { path },
        commit: { sha: this.branchCommit.get(p.branch) },
      })
    }
    if (method === 'GET' && rest === '/pulls') {
      return send(
        200,
        this.pulls.map((p) => ({
          number: p.number,
          state: 'open',
          head: { ref: p.head },
          base: { ref: p.base },
        })),
      )
    }
    if (method === 'POST' && rest === '/pulls') {
      const p = body as { title: string; body: string; head: string; base: string }
      if (!this.branches.has(p.head) || !this.branches.has(p.base))
        return send(422, { message: 'Validation Failed' })
      const number = this.pulls.length + 1
      const pull: FakePull = {
        ...p,
        number,
        labels: [],
        html_url: `https://github.example/${this.repo}/pull/${number}`,
      }
      this.pulls.push(pull)
      return send(201, { number, html_url: pull.html_url })
    }
    if (method === 'POST' && (m = rest.match(/^\/issues\/(\d+)\/labels$/))) {
      const pull = this.pulls.find((p) => p.number === Number(m![1]))
      if (!pull) return send(404, { message: 'Not Found' })
      pull.labels.push(...(body as { labels: string[] }).labels)
      return send(200, [])
    }
    return send(404, { message: 'Not Found' })
  }
}

function sha1(v: string): string {
  return createHash('sha1').update(v).digest('hex')
}
function blobSha(content: string): string {
  return sha1(`blob ${Buffer.byteLength(content)}\0${content}`)
}
