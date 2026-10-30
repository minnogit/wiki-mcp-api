import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LEGACY_PRINCIPAL,
  canAccessWiki,
  createAuthFromEnv,
  createAuthenticator,
  hashToken,
} from '../src/auth.js'
import { ConfigError } from '../src/config.js'
import { TokenFileStore, parseTokenFile, writeTokenFile } from '../src/token-file.js'

const dirs: string[] = []
function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-tokens-'))
  dirs.push(d)
  return path.join(d, 'tokens.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const entry = (id: string, token: string, extra: Record<string, unknown> = {}) => ({
  id,
  user: id,
  wikis: '*',
  tokenHash: hashToken(token),
  ...extra,
})

describe('parseTokenFile', () => {
  it('accetta voci valide con campi opzionali', () => {
    const out = parseTokenFile(
      [
        entry('a', 'ta', { groups: ['g'], expiresAt: '2030-01-01T00:00:00Z', note: 'n' }),
        entry('b', 'tb', { wikis: ['hr', 'it'] }),
      ],
      ['hr', 'it'],
    )
    expect(out).toHaveLength(2)
  })

  it('rifiuta campi sconosciuti (.strict) e, in particolare, un token in chiaro', () => {
    expect(() => parseTokenFile([{ ...entry('a', 'ta'), token: 'wmcp_xxx' }])).toThrow(/token/)
  })

  it('rifiuta hash malformati, id duplicati, id riservato, wikis vuoto, data non valida', () => {
    const bad = (e: unknown) => expect(() => parseTokenFile(e)).toThrow(ConfigError)
    bad([entry('a', 'x', { tokenHash: 'sha256:abc' })])
    bad([entry('a', 'x', { tokenHash: 'md5:' + 'a'.repeat(32) })])
    bad([entry('a', 'x'), entry('a', 'y')])
    bad([entry('legacy', 'x')])
    bad([entry('a', 'x', { wikis: [] })])
    bad([entry('a', 'x', { expiresAt: 'domani' })])
    bad({ id: 'a' })
  })

  it('rifiuta hash uguali su voci diverse', () => {
    expect(() => parseTokenFile([entry('a', 'x'), entry('b', 'x')])).toThrow(/stesso hash/)
  })

  it('wikis deve riferirsi a wiki esistenti, salvo "*", con messaggio chiaro', () => {
    expect(() => parseTokenFile([entry('a', 'x', { wikis: ['hr', 'xx'] })], ['hr'])).toThrow(
      /"xx" non esiste/,
    )
    expect(() => parseTokenFile([entry('a', 'x', { wikis: '*' })], ['hr'])).not.toThrow()
  })
})

describe('autenticazione', () => {
  const entries = parseTokenFile([
    entry('alice', 'tok-alice', { wikis: ['hr'], groups: ['hr'] }),
    entry('bob', 'tok-bob'),
    entry('old', 'tok-old', { expiresAt: '2020-01-01T00:00:00Z' }),
  ])
  const auth = createAuthenticator({ entries: () => entries, now: () => Date.parse('2026-01-01') })

  it('riconosce il token e restituisce il principal con gruppi e wiki', () => {
    expect(auth.authenticate('tok-alice')).toEqual({
      id: 'alice',
      user: 'alice',
      groups: ['hr'],
      wikis: ['hr'],
    })
    expect(auth.authenticate('tok-bob')?.wikis).toBe('*')
  })

  it('rifiuta token sconosciuti, vuoti e scaduti', () => {
    expect(auth.authenticate('tok-alicE')).toBeUndefined()
    expect(auth.authenticate('')).toBeUndefined()
    expect(auth.authenticate('tok-old')).toBeUndefined()
  })

  it('la scadenza è valutata sull orologio iniettato', () => {
    const early = createAuthenticator({
      entries: () => entries,
      now: () => Date.parse('2019-01-01'),
    })
    expect(early.authenticate('tok-old')?.id).toBe('old')
  })

  it('l hash è sha256 del token completo, formato sha256:<hex>', () => {
    expect(hashToken('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('il token legacy vale insieme a quelli per utente', () => {
    const both = createAuthenticator({ legacyToken: 'vecchio', entries: () => entries })
    expect(both.authenticate('vecchio')).toEqual(LEGACY_PRINCIPAL)
    expect(both.authenticate('tok-bob')?.id).toBe('bob')
    expect(createAuthenticator({ entries: () => entries }).authenticate('vecchio')).toBeUndefined()
  })

  it('canAccessWiki', () => {
    expect(canAccessWiki(LEGACY_PRINCIPAL, 'qualsiasi')).toBe(true)
    const alice = auth.authenticate('tok-alice')!
    expect(canAccessWiki(alice, 'hr')).toBe(true)
    expect(canAccessWiki(alice, 'it')).toBe(false)
  })
})

describe('createAuthFromEnv (avvio)', () => {
  it('senza né token legacy né file si rifiuta di partire', () => {
    expect(() => createAuthFromEnv({}, ['default'])).toThrow(ConfigError)
    expect(() => createAuthFromEnv({ MCP_HTTP_TOKEN: '', MCP_HTTP_TOKENS_FILE: ' ' }, [])).toThrow(
      /Nessuna credenziale/,
    )
  })

  it('solo legacy: funziona e produce un avviso che consiglia i token per utente', () => {
    const s = createAuthFromEnv({ MCP_HTTP_TOKEN: 'x' }, ['default'])
    expect(s.authenticator.authenticate('x')).toEqual(LEGACY_PRINCIPAL)
    expect(s.warnings.join(' ')).toMatch(/token per utente/)
  })

  it('con il file non c è avviso; legacy e file insieme sono entrambi validi', () => {
    const file = tmpFile()
    writeTokenFile(file, parseTokenFile([entry('bob', 'tok-bob')]))
    const only = createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: file }, ['default'])
    expect(only.warnings).toEqual([])
    expect(only.authenticator.authenticate('tok-bob')?.id).toBe('bob')
    const both = createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: file, MCP_HTTP_TOKEN: 'leg' }, [])
    expect(both.warnings).toEqual([])
    expect(both.authenticator.authenticate('leg')?.id).toBe('legacy')
    expect(both.authenticator.authenticate('tok-bob')?.id).toBe('bob')
  })

  it('file mancante o invalido all avvio: errore, anche con il token legacy', () => {
    expect(() =>
      createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: '/non/esiste.json', MCP_HTTP_TOKEN: 'x' }, []),
    ).toThrow(ConfigError)
    const file = tmpFile()
    fs.writeFileSync(file, '{non json')
    expect(() => createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: file }, [])).toThrow(/JSON/)
  })

  it('una wiki inesistente nel file è un errore di avvio', () => {
    const file = tmpFile()
    writeTokenFile(file, parseTokenFile([entry('a', 'x', { wikis: ['fantasma'] })]))
    expect(() => createAuthFromEnv({ MCP_HTTP_TOKENS_FILE: file }, ['hr'])).toThrow(/fantasma/)
  })
})

describe('TokenFileStore: ricarica a caldo', () => {
  function setup(initial: unknown[]) {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify(initial))
    const logs: string[] = []
    let t = 1_000_000
    const store = new TokenFileStore(file, ['hr'], {
      checkIntervalMs: 1000,
      now: () => t,
      logger: (m) => logs.push(m),
    })
    const auth = createAuthenticator({ entries: () => store.entries() })
    return {
      file,
      logs,
      auth,
      tick: (ms = 1500) => (t += ms),
    }
  }

  it('una revoca ha effetto senza riavvio, e un token nuovo viene accettato', () => {
    const s = setup([entry('a', 'ta'), entry('b', 'tb')])
    expect(s.auth.authenticate('ta')?.id).toBe('a')
    fs.writeFileSync(s.file, JSON.stringify([entry('b', 'tb'), entry('c', 'tc')]))
    // entro l'intervallo non si rilegge
    expect(s.auth.authenticate('ta')?.id).toBe('a')
    s.tick()
    expect(s.auth.authenticate('ta')).toBeUndefined()
    expect(s.auth.authenticate('tc')?.id).toBe('c')
    expect(s.auth.authenticate('tb')?.id).toBe('b')
  })

  it('un file invalido a runtime mantiene l ultima versione valida e logga una volta', () => {
    const s = setup([entry('a', 'ta')])
    fs.writeFileSync(s.file, '[ {rotto')
    s.tick()
    expect(s.auth.authenticate('ta')?.id).toBe('a')
    expect(s.logs.join('\n')).toMatch(/non è JSON valido/)
    expect(s.logs.join('\n')).toMatch(/ultima versione valida/)
    const n = s.logs.length
    s.tick()
    s.auth.authenticate('ta')
    expect(s.logs).toHaveLength(n)
  })

  it('un file valido nel formato ma con wiki inesistente non viene adottato', () => {
    const s = setup([entry('a', 'ta')])
    fs.writeFileSync(s.file, JSON.stringify([entry('b', 'tb', { wikis: ['nope'] })]))
    s.tick()
    expect(s.auth.authenticate('tb')).toBeUndefined()
    expect(s.auth.authenticate('ta')?.id).toBe('a')
  })

  it('dopo un file invalido, la correzione viene ricaricata', () => {
    const s = setup([entry('a', 'ta')])
    fs.writeFileSync(s.file, 'xx')
    s.tick()
    s.auth.authenticate('ta')
    fs.writeFileSync(s.file, JSON.stringify([entry('z', 'tz')]))
    s.tick()
    expect(s.auth.authenticate('tz')?.id).toBe('z')
    expect(s.auth.authenticate('ta')).toBeUndefined()
  })

  it('file cancellato a runtime: si tiene l ultima versione valida', () => {
    const s = setup([entry('a', 'ta')])
    fs.rmSync(s.file)
    s.tick()
    expect(s.auth.authenticate('ta')?.id).toBe('a')
    expect(s.logs.join('\n')).toMatch(/non leggibile/)
  })

  it('i log non contengono mai token né hash completi', () => {
    const s = setup([entry('a', 'ta')])
    fs.writeFileSync(s.file, 'xx')
    s.tick()
    s.auth.authenticate('ta')
    expect(s.logs.join('\n')).not.toContain(hashToken('ta').slice(7))
  })
})
