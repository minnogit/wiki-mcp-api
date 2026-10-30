import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitHubError, createGitHubClient, type GitHubApi } from '../src/github.js'
import { FakeGitHub } from './fake-github.js'

let fake: FakeGitHub
let gh: GitHubApi
const BOT = { name: 'bot', email: 'bot@example.com' }

beforeEach(async () => {
  fake = new FakeGitHub()
  await fake.start()
  gh = createGitHubClient({ apiUrl: fake.url, token: fake.token, repo: fake.repo, timeoutMs: 500 })
})
afterEach(async () => {
  await fake.stop()
})

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    if (e instanceof GitHubError) return e.kind
    throw e
  }
  return 'ok'
}

describe('cliente GitHub contro il finto server', () => {
  it('legge lo SHA del branch base e manda il token solo nell intestazione Authorization', async () => {
    const sha = await gh.getBranchSha('main')
    expect(sha).toBe(fake.branchCommit.get('main'))
    expect(fake.requests[0].authorization).toBe(`Bearer ${fake.token}`)
    expect(fake.requests[0].path).not.toContain(fake.token)
  })

  it('crea un branch, crea un file e apre la PR', async () => {
    const base = await gh.getBranchSha('main')
    await gh.createBranch('proposta/x', base)
    await gh.putFile({
      path: 'wiki/a/b.md',
      branch: 'proposta/x',
      message: 'msg',
      content: 'ciao àè\n',
      author: BOT,
      committer: BOT,
    })
    expect(fake.branches.get('proposta/x')!.get('wiki/a/b.md')!.content).toBe('ciao àè\n')
    expect(fake.commits[0]).toMatchObject({ author: BOT, committer: BOT, message: 'msg' })
    const pr = await gh.createPull({ title: 't', body: 'b', head: 'proposta/x', base: 'main' })
    expect(pr).toEqual({ number: 1, url: `https://github.example/${fake.repo}/pull/1` })
    await gh.addLabels(1, ['wiki', 'proposta'])
    expect(fake.pulls[0].labels).toEqual(['wiki', 'proposta'])
    // main non è stato toccato
    expect(fake.branches.get('main')!.size).toBe(0)
  })

  it('aggiorna con lo SHA del blob esistente; getFile restituisce sha e contenuto, null se manca', async () => {
    fake.seed('wiki/p.md', 'vecchio\n')
    const base = await gh.getBranchSha('main')
    const file = await gh.getFile('wiki/p.md', base)
    expect(file?.content).toBe('vecchio\n')
    expect(await gh.getFile('wiki/non-c-e.md', base)).toBeNull()
    await gh.createBranch('proposta/y', base)
    await gh.putFile({
      path: 'wiki/p.md',
      branch: 'proposta/y',
      message: 'm',
      content: 'nuovo\n',
      sha: file!.sha,
      author: BOT,
      committer: BOT,
    })
    expect(fake.branches.get('proposta/y')!.get('wiki/p.md')!.content).toBe('nuovo\n')
  })

  it('conflitto: SHA non corrispondente -> kind conflict', async () => {
    fake.seed('wiki/p.md', 'vecchio\n')
    const base = await gh.getBranchSha('main')
    await gh.createBranch('proposta/z', base)
    expect(
      await kindOf(
        gh.putFile({
          path: 'wiki/p.md',
          branch: 'proposta/z',
          message: 'm',
          content: 'x',
          sha: 'sha-vecchio',
          author: BOT,
          committer: BOT,
        }),
      ),
    ).toBe('conflict')
    // senza sha su un file esistente: GitHub risponde 409
    expect(
      await kindOf(
        gh.putFile({
          path: 'wiki/p.md',
          branch: 'proposta/z',
          message: 'm',
          content: 'x',
          author: BOT,
          committer: BOT,
        }),
      ),
    ).toBe('conflict')
  })

  it('cancella un branch (ripulitura)', async () => {
    const base = await gh.getBranchSha('main')
    await gh.createBranch('proposta/w', base)
    await gh.deleteBranch('proposta/w')
    expect(fake.branches.has('proposta/w')).toBe(false)
  })

  it('conta le PR aperte con il prefisso, fermandosi al tetto', async () => {
    const base = await gh.getBranchSha('main')
    for (const n of ['proposta/a', 'proposta/b', 'altro/c']) {
      await gh.createBranch(n, base)
      await gh.createPull({ title: 't', body: '', head: n, base: 'main' })
    }
    expect(await gh.countOpenPulls('proposta/', 10)).toBe(2)
    expect(await gh.countOpenPulls('proposta/', 1)).toBe(1)
  })

  it('classifica gli errori per tipo, senza il corpo di GitHub né il token nel messaggio', async () => {
    const cases: [number, string, string][] = [
      [401, 'Bad credentials', 'auth'],
      [403, 'Resource not accessible', 'auth'],
      [403, 'API rate limit exceeded for user', 'rate-limit'],
      [429, 'slow down', 'rate-limit'],
      [404, 'Not Found', 'not-found'],
      [409, 'conflict', 'conflict'],
      [422, 'Validation Failed', 'validation'],
      [502, 'Bad gateway', 'server'],
    ]
    for (const [status, message, kind] of cases) {
      fake.failNext('GET', /\/git\/ref\//, status, message)
      let err: GitHubError | undefined
      try {
        await gh.getBranchSha('main')
      } catch (e) {
        err = e as GitHubError
      }
      expect(err?.kind, `${status} ${message}`).toBe(kind)
      expect(err?.message).not.toContain(fake.token)
      expect(err?.message).not.toContain('secret-internal')
    }
  })

  it('timeout: kind timeout', async () => {
    fake.failAlways('GET', /\/git\/ref\//, 200, { delayMs: 1500 })
    expect(await kindOf(gh.getBranchSha('main'))).toBe('timeout')
  })

  it('server irraggiungibile: kind network, senza il token nel messaggio', async () => {
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as net.AddressInfo).port
    await new Promise((r) => srv.close(r))
    const dead = createGitHubClient({
      apiUrl: `http://127.0.0.1:${port}`,
      token: fake.token,
      repo: fake.repo,
      timeoutMs: 500,
    })
    try {
      await dead.getBranchSha('main')
      expect.unreachable()
    } catch (e) {
      expect((e as GitHubError).kind).toBe('network')
      expect((e as GitHubError).message).not.toContain(fake.token)
    }
  })

  it('token sbagliato: auth', async () => {
    const bad = createGitHubClient({ apiUrl: fake.url, token: 'ghp_sbagliato', repo: fake.repo })
    expect(await kindOf(bad.getBranchSha('main'))).toBe('auth')
  })
})
