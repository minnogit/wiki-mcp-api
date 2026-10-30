import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDITED_TOOLS } from '../src/audit.js'
import { LEGACY_PRINCIPAL, canPropose, createAuthenticator, hashToken } from '../src/auth.js'
import { runCli } from '../src/cli/token.js'
import { ConfigError, PROPOSAL_DEFAULTS, parseWikiConfig } from '../src/config.js'
import { createProposerFromConfig } from '../src/proposals.js'
import { buildRemoteServer } from '../src/server.js'
import { loadTokenFile, parseTokenFile } from '../src/token-file.js'
import { createWikiService } from '../src/wiki/service.js'
import { makeProposalEnv, principal, type ProposalEnv } from './proposal-helpers'
import { makeTelemetry } from './obs-helpers'

const BASE = path.resolve('/srv/wikis')
const cfg = (proposals: unknown) =>
  parseWikiConfig([{ name: 'hr', wikiPath: 'w', proposals }], BASE)[0].proposals

describe('configurazione proposals', () => {
  it('applica i valori predefiniti', () => {
    expect(cfg({ repo: 'acme/wiki' })).toEqual({
      repo: 'acme/wiki',
      ...PROPOSAL_DEFAULTS,
      labels: [],
    })
    expect(PROPOSAL_DEFAULTS.pathPrefix).toBe('wiki/')
  })

  it('normalizza pathPrefix e apiUrl', () => {
    expect(cfg({ repo: 'a/b', pathPrefix: '/docs/wiki' })?.pathPrefix).toBe('docs/wiki/')
    expect(cfg({ repo: 'a/b', pathPrefix: '' })?.pathPrefix).toBe('')
    expect(cfg({ repo: 'a/b', pathPrefix: '.' })?.pathPrefix).toBe('')
    expect(cfg({ repo: 'a/b', apiUrl: 'https://ghe.example.com/api/v3/' })?.apiUrl).toBe(
      'https://ghe.example.com/api/v3',
    )
    expect(cfg({ repo: 'a/b', apiUrl: 'http://127.0.0.1:1234' })?.apiUrl).toBe(
      'http://127.0.0.1:1234',
    )
  })

  it.each([
    [{ repo: 'senza-slash' }, /repo/],
    [{ repo: 'a/b', altro: 1 }, /altro|Unrecognized/],
    [{ repo: 'a/b', pathPrefix: '../fuori' }, /pathPrefix/],
    [{ repo: 'a/b', tokenEnv: 'ghp_abc123 segreto' }, /NOME/],
    [{ repo: 'a/b', apiUrl: 'http://github.example.com' }, /apiUrl/],
    [{ repo: 'a/b', apiUrl: 'https://u:p@example.com' }, /apiUrl/],
    [{ repo: 'a/b', baseBranch: 'a..b' }, /baseBranch/],
    [{ repo: 'a/b', botName: 'x\ny' }, /botName/],
    [{ repo: 'a/b', maxOpenPulls: 0 }, /maxOpenPulls/],
  ])('rifiuta %j', (proposals, re) => {
    expect(() => cfg(proposals)).toThrow(ConfigError)
    expect(() => cfg(proposals)).toThrow(re)
  })

  it('senza proposals il contesto non ha il campo', () => {
    const [w] = parseWikiConfig([{ name: 'hr', wikiPath: 'w' }], BASE)
    expect('proposals' in w).toBe(false)
  })
})

describe('avvio con proposals', () => {
  let env: ProposalEnv | undefined
  afterEach(async () => {
    await env?.close()
    env = undefined
  })

  it('variabile del token mancante o vuota: ConfigError chiaro, senza valori segreti', async () => {
    env = await makeProposalEnv()
    const svc = createWikiService({ ...env.fx.svc.context, proposals: env.config })
    const { tel } = makeTelemetry()
    expect(() => createProposerFromConfig(svc, {}, tel)).toThrow(ConfigError)
    expect(() => createProposerFromConfig(svc, { GITHUB_TOKEN: '  ' }, tel)).toThrow(/GITHUB_TOKEN/)
    expect(() => createProposerFromConfig(svc, { GITHUB_TOKEN: 'ghp_x' }, tel)).not.toThrow()
    // tokenEnv personalizzato
    const svc2 = createWikiService({
      ...env.fx.svc.context,
      proposals: { ...env.config, tokenEnv: 'WIKI_GH' },
    })
    expect(() => createProposerFromConfig(svc2, { GITHUB_TOKEN: 'ghp_x' }, tel)).toThrow(/WIKI_GH/)
  })

  it('il tool è montato solo con un proposer: senza proposals non esiste per quella wiki', async () => {
    env = await makeProposalEnv()
    const { tel } = makeTelemetry()
    const senza = buildRemoteServer(env.fx.svc, { exposeRaw: false, telemetry: tel })
    expect(Object.keys(senza.tools())).not.toContain('wikiProposePage')
    const con = buildRemoteServer(env.fx.svc, {
      exposeRaw: false,
      telemetry: tel,
      proposer: env.proposer,
    })
    expect(Object.keys(con.tools())).toContain('wikiProposePage')
    expect(Object.keys(con.tools())).not.toContain('wikiWritePage')
    for (const name of Object.keys(con.tools())) expect(AUDITED_TOOLS).toContain(name)
    // le istruzioni descrivono l esito come PR da rivedere, solo se il tool esiste
    const instr = (s: typeof con) => (s as unknown as { instructions?: string }).instructions ?? ''
    expect(instr(con)).toMatch(/wikiProposePage NON modifica la wiki/)
    expect(instr(senza)).not.toMatch(/wikiProposePage/)
  })

  it('processo vero: http.ts rifiuta di partire se il token GitHub manca; parte se c è', async () => {
    env = await makeProposalEnv()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-propcfg-'))
    try {
      const cfgFile = path.join(dir, 'wikis.json')
      fs.writeFileSync(
        cfgFile,
        JSON.stringify([
          {
            name: 'hr',
            wikiPath: env.fx.wikiDir,
            proposals: { repo: env.fake.repo, apiUrl: env.fake.url },
          },
        ]),
      )
      const srv = net.createServer()
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
      const port = (srv.address() as net.AddressInfo).port
      await new Promise((r) => srv.close(r))
      const baseEnv = {
        PATH: process.env.PATH,
        WIKI_CONFIG: cfgFile,
        MCP_HTTP_TOKEN: 'tok-x',
        MCP_HTTP_PORT: String(port),
      }
      const launch = (extra: Record<string, string>) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
          cwd: path.resolve(__dirname, '..'),
          env: { ...baseEnv, ...extra },
        })
        let out = ''
        child.stdout.on('data', (d: Buffer) => (out += d.toString()))
        return { child, out: () => out }
      }
      // senza token: esce con 1 e dice quale variabile manca
      const a = launch({})
      const code = await new Promise<number | null>((r) => a.child.once('close', r))
      expect(code).toBe(1)
      expect(a.out()).toMatch(/GITHUB_TOKEN/)
      // con token: parte e annuncia il tool, senza stampare il token
      const b = launch({ GITHUB_TOKEN: 'ghp_SEGRETO_DI_PROVA' })
      const end = Date.now() + 20_000
      while (!b.out().includes('wikiProposePage attivo') && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50))
      b.child.kill('SIGTERM')
      await new Promise((r) => b.child.once('close', r))
      expect(b.out()).toContain('wikiProposePage attivo')
      expect(b.out()).not.toContain('ghp_SEGRETO_DI_PROVA')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})

describe('permesso propose nel token per utente', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmpFile = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-propose-'))
    dirs.push(d)
    return path.join(d, 'tokens.json')
  }
  const run = (argv: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = runCli(argv, {}, { out: (t) => out.push(t), err: (t) => err.push(t) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const entry = (extra: Record<string, unknown> = {}) => ({
    id: 'a',
    user: 'a',
    wikis: ['hr'],
    tokenHash: hashToken('t'),
    ...extra,
  })

  it('schema retrocompatibile: propose assente = nessun permesso', () => {
    const [e] = parseTokenFile([entry()])
    expect(e.propose).toBeUndefined()
    const auth = createAuthenticator({ entries: () => [e] })
    expect(auth.authenticate('t')?.propose).toEqual([])
    expect(canPropose(auth.authenticate('t')!, 'hr')).toBe(false)
  })

  it('propose elencato, "*" e validazione contro wikis e wiki esistenti', () => {
    expect(parseTokenFile([entry({ propose: ['hr'] })])[0].propose).toEqual(['hr'])
    expect(parseTokenFile([entry({ wikis: '*', propose: '*' })])[0].propose).toBe('*')
    expect(() => parseTokenFile([entry({ propose: ['it'] })])).toThrow(/non è tra le wikis/)
    expect(() => parseTokenFile([entry({ wikis: '*', propose: ['xx'] })], ['hr'])).toThrow(
      /non esiste/,
    )
    expect(() => parseTokenFile([entry({ propose: 'hr' })])).toThrow()
  })

  it('il principal porta propose e canPropose richiede anche l accesso alla wiki; il legacy mai', () => {
    const auth = createAuthenticator({
      entries: () =>
        parseTokenFile([
          entry({ propose: ['hr'] }),
          entry({ id: 'b', tokenHash: hashToken('u'), wikis: '*', propose: '*' }),
        ]),
    })
    const a = auth.authenticate('t')!
    expect(a.propose).toEqual(['hr'])
    expect(canPropose(a, 'hr')).toBe(true)
    expect(canPropose(a, 'it')).toBe(false)
    expect(canPropose(auth.authenticate('u')!, 'qualunque')).toBe(true)
    expect(canPropose(principal('x', [], { wikis: ['it'], propose: ['hr'] }), 'hr')).toBe(false)
    expect(canPropose(LEGACY_PRINCIPAL, 'hr')).toBe(false)
    expect(createAuthenticator({ legacyToken: 'L' }).authenticate('L')?.propose).toEqual([])
  })

  it('CLI: create --propose scrive il campo, list lo mostra, errori chiari', () => {
    const file = tmpFile()
    expect(
      run([
        'create',
        '--user',
        'alice',
        '--wikis',
        'hr,it',
        '--propose',
        'hr',
        '--id',
        'a1',
        '--file',
        file,
      ]).code,
    ).toBe(0)
    expect(
      run([
        'create',
        '--user',
        'bot',
        '--wikis',
        '*',
        '--propose',
        '*',
        '--id',
        'b1',
        '--file',
        file,
      ]).code,
    ).toBe(0)
    expect(
      run(['create', '--user', 'bob', '--wikis', 'hr', '--id', 'c1', '--file', file]).code,
    ).toBe(0)
    const entries = loadTokenFile(file)
    expect(entries[0].propose).toEqual(['hr'])
    expect(entries[1].propose).toBe('*')
    expect('propose' in entries[2]).toBe(false)
    const list = run(['list', '--file', file]).out
    expect(list).toMatch(/PROPONE/)
    const rows = list.split('\n')
    expect(rows[1]).toMatch(/alice\s+-\s+hr,it\s+hr\s/)
    expect(rows[2]).toMatch(/bot\s+-\s+\*\s+\*\s/)
    expect(rows[3]).toMatch(/bob\s+-\s+hr\s+-\s/)
    const bad = run(['create', '--user', 'x', '--wikis', 'hr', '--propose', 'it', '--file', file])
    expect(bad.code).toBe(1)
    expect(bad.err).toMatch(/non è tra le wikis/)
    expect(loadTokenFile(file)).toHaveLength(3)
  })
})
