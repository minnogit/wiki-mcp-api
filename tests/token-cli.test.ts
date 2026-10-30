import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthenticator, hashToken } from '../src/auth.js'
import { TOKEN_PREFIX, runCli } from '../src/cli/token.js'
import { loadTokenFile } from '../src/token-file.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = runCli(argv, env, { out: (t) => out.push(t), err: (t) => err.push(t) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-cli-'))
  dirs.push(d)
  return path.join(d, 'tokens.json')
}

describe('CLI token', () => {
  it('create: stampa il token una volta, scrive solo l hash, file 0600', () => {
    const file = tmpFile()
    const r = run([
      'create',
      '--user',
      'alice',
      '--wikis',
      'hr,it',
      '--groups',
      'hr',
      '--file',
      file,
    ])
    expect(r.code).toBe(0)
    const token = r.out.trim()
    expect(token).toMatch(new RegExp(`^${TOKEN_PREFIX}[0-9a-f]{64}$`))
    expect(r.err).not.toContain(token)
    const raw = fs.readFileSync(file, 'utf-8')
    expect(raw).not.toContain(token)
    expect(raw).not.toContain(token.slice(TOKEN_PREFIX.length))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const [e] = loadTokenFile(file)
    expect(e).toMatchObject({ user: 'alice', wikis: ['hr', 'it'], groups: ['hr'] })
    expect(e.tokenHash).toBe(hashToken(token))
    // il token creato è davvero accettato da chi legge il file
    const auth = createAuthenticator({ entries: () => loadTokenFile(file) })
    expect(auth.authenticate(token)?.user).toBe('alice')
  })

  it('create: aggiunge a un file esistente, id esplicito, scadenza, note, wikis "*"', () => {
    const file = tmpFile()
    run(['create', '--user', 'alice', '--wikis', 'hr', '--file', file])
    const r = run(
      [
        'create',
        '--user',
        'bot',
        '--wikis',
        '*',
        '--id',
        'ci-bot',
        '--expires',
        '2030-01-01T00:00:00Z',
        '--note',
        'CI',
      ],
      { MCP_HTTP_TOKENS_FILE: file },
    )
    expect(r.code).toBe(0)
    const entries = loadTokenFile(file)
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({
      id: 'ci-bot',
      wikis: '*',
      expiresAt: '2030-01-01T00:00:00Z',
      note: 'CI',
    })
    expect(entries[0].id).toMatch(/^alice-[0-9a-f]{4}$/)
  })

  it('create: errori chiari (id duplicato, data non valida, argomenti mancanti) senza token', () => {
    const file = tmpFile()
    expect(run(['create', '--user', 'a', '--wikis', 'hr', '--id', 'x', '--file', file]).code).toBe(
      0,
    )
    const dup = run(['create', '--user', 'b', '--wikis', 'hr', '--id', 'x', '--file', file])
    expect(dup.code).toBe(1)
    expect(dup.err).toMatch(/duplicato/)
    expect(dup.out).toBe('')
    expect(
      run(['create', '--user', 'b', '--wikis', 'hr', '--expires', 'boh', '--file', file]).code,
    ).toBe(1)
    expect(run(['create', '--wikis', 'hr', '--file', file]).err).toMatch(/--user/)
    expect(run(['create', '--user', 'b', '--file', file]).err).toMatch(/--wikis/)
    expect(run(['create', '--user', 'b', '--wikis', 'hr']).err).toMatch(/--file/)
    expect(loadTokenFile(file)).toHaveLength(1)
  })

  it('list: mostra id, utente, gruppi, wiki, scadenza, mai hash', () => {
    const file = tmpFile()
    run([
      'create',
      '--user',
      'alice',
      '--wikis',
      'hr',
      '--id',
      'a1',
      '--groups',
      'g1,g2',
      '--file',
      file,
    ])
    run([
      'create',
      '--user',
      'old',
      '--wikis',
      '*',
      '--id',
      'o1',
      '--expires',
      '2020-01-01T00:00:00Z',
      '--file',
      file,
    ])
    const r = run(['list', '--file', file])
    expect(r.code).toBe(0)
    expect(r.out).toContain('a1')
    expect(r.out).toContain('g1,g2')
    expect(r.out).toContain('SCADUTO')
    expect(r.out).not.toMatch(/sha256|[0-9a-f]{16}/)
    expect(run(['list', '--file', tmpFile()]).out).toBe('(nessun token)')
  })

  it('revoke: toglie la voce, errore se l id non esiste, permessi preservati', () => {
    const file = tmpFile()
    run(['create', '--user', 'a', '--wikis', 'hr', '--id', 'a1', '--file', file])
    run(['create', '--user', 'b', '--wikis', 'hr', '--id', 'b1', '--file', file])
    fs.chmodSync(file, 0o640)
    expect(run(['revoke', 'zz', '--file', file]).code).toBe(1)
    expect(run(['revoke', 'a1', '--file', file]).code).toBe(0)
    expect(loadTokenFile(file).map((e) => e.id)).toEqual(['b1'])
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tokens.json'])
  })

  it('comando sconosciuto o assente', () => {
    expect(run(['boh', '--file', tmpFile()]).code).toBe(1)
    expect(run([]).code).toBe(1)
    expect(run(['--help']).code).toBe(0)
  })
})
