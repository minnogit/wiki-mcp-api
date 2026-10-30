import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../src/config.js'
import {
  AppendFile,
  createLogger,
  formatLine,
  loggerFromEnv,
  sanitize,
  shortError,
  truncate,
} from '../src/log.js'

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = []
  return { lines, log: createLogger({ ...opts, sink: (l) => lines.push(l) }) }
}

describe('logger: livelli e formato', () => {
  it('JSON a righe con ts ISO UTC, level, event e campi extra', () => {
    const { lines, log } = capture()
    log.info('startup', { msg: 'ciao', port: 3000 })
    const e = JSON.parse(lines[0]) as Record<string, unknown>
    expect(e).toMatchObject({ level: 'info', event: 'startup', msg: 'ciao', port: 3000 })
    expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  it('rispetta il livello: sotto la soglia non scrive', () => {
    const { lines, log } = capture({ level: 'warn' })
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['c', 'd'])
  })

  it('always scrive anche con livello silent (audit non si spegne con LOG_LEVEL)', () => {
    const { lines, log } = capture({ level: 'silent' })
    log.error('x')
    log.always('audit', { tool: 't' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"event":"audit"')
  })

  it('i campi extra non possono sovrascrivere ts, level ed event', () => {
    const { lines, log } = capture()
    log.info('vero', { event: 'falso', level: 'debug', ts: 'ieri' })
    const e = JSON.parse(lines[0]) as Record<string, string>
    expect(e.event).toBe('vero')
    expect(e.level).toBe('info')
    expect(e.ts).not.toBe('ieri')
  })

  it('formato text: leggibile, valori con spazi tra virgolette', () => {
    const { lines, log } = capture({ format: 'text' })
    log.info('startup', { msg: 'in ascolto', port: 3000 })
    expect(lines[0]).toMatch(/^\S+ INFO {2}startup msg="in ascolto" port=3000$/)
  })

  it('loggerFromEnv: default json in HTTP e text in stdio; valori non validi tornano al default', () => {
    expect(loggerFromEnv({}, 'http').format).toBe('json')
    expect(loggerFromEnv({}, 'stdio').format).toBe('text')
    expect(loggerFromEnv({ LOG_FORMAT: 'text' }, 'http').format).toBe('text')
    expect(loggerFromEnv({ LOG_LEVEL: 'DEBUG' }, 'http').level).toBe('debug')
    expect(loggerFromEnv({ LOG_LEVEL: 'boh', LOG_FORMAT: 'xml' }, 'http')).toMatchObject({
      level: 'info',
      format: 'json',
    })
  })

  it('stdio scrive solo su stderr, HTTP su stdout', () => {
    const out: string[] = []
    const err: string[] = []
    const so = process.stdout.write.bind(process.stdout)
    const se = process.stderr.write.bind(process.stderr)
    process.stdout.write = (c: string) => (out.push(String(c)), true)
    process.stderr.write = (c: string) => (err.push(String(c)), true)
    try {
      loggerFromEnv({}, 'stdio').info('a')
      loggerFromEnv({}, 'http').info('b')
    } finally {
      process.stdout.write = so
      process.stderr.write = se
    }
    expect(err.join('')).toContain(' a')
    expect(out.join('')).toContain('"event":"b"')
    expect(out.join('')).not.toContain(' a')
  })
})

describe('sanificazione', () => {
  it('redige le chiavi sensibili a qualunque profondità, ma non contentLength', () => {
    const out = sanitize({
      token: 'x',
      nested: { Authorization: 'Bearer y', tokenHash: 'h', content: 'testo', contentLength: 5 },
      list: [{ password: 'p' }],
    }) as {
      token: string
      nested: Record<string, unknown>
      list: { password: string }[]
    }
    expect(out.token).toBe('[redatto]')
    expect(out.nested.Authorization).toBe('[redatto]')
    expect(out.nested.tokenHash).toBe('[redatto]')
    expect(out.nested.content).toBe('[redatto]')
    expect(out.nested.contentLength).toBe(5)
    expect(out.list[0].password).toBe('[redatto]')
  })

  it('ripulisce Bearer e hash sha256 dentro le stringhe', () => {
    const hash = 'sha256:' + 'ab'.repeat(32)
    const out = sanitize(`Authorization: Bearer abc.DEF-123 e ${hash}`) as string
    expect(out).not.toContain('abc.DEF')
    expect(out).not.toContain('abab')
  })

  it('Error: solo nome e messaggio breve, mai lo stack', () => {
    const e = new Error('boom\n    at /home/x/file.ts:1:1')
    const out = sanitize(e) as { message: string }
    expect(JSON.stringify(out)).not.toContain('at /home')
    expect(out.message).toBe('boom')
  })

  it('shortError toglie i percorsi assoluti e tronca', () => {
    expect(shortError(new Error("ENOENT: no such file '/srv/wiki/concetti/x.md'"))).toBe(
      "ENOENT: no such file '<percorso>'",
    )
    expect(shortError(new Error('a'.repeat(500))).length).toBeLessThanOrEqual(201)
  })

  it('truncate non spezza le coppie surrogate', () => {
    expect(truncate('😀😀😀', 2)).toBe('😀😀…')
  })

  it('limita profondità e ampiezza', () => {
    const deep = sanitize({ a: { b: { c: { d: { e: 1 } } } } })
    expect(JSON.stringify(deep)).toContain('[troncato]')
    const wide = sanitize(Array.from({ length: 100 }, (_, i) => i)) as unknown[]
    expect(wide.length).toBe(21)
  })

  it('niente iniezione di righe: i newline sono escapati in json e in text', () => {
    const evil = 'riga1\nINFO fake event=audit\r\nriga3'
    for (const format of ['json', 'text'] as const) {
      const line = formatLine(format, 'info', 'audit', { q: evil, 'chiave\nfinta': 1 })
      expect(line).not.toMatch(/[\r\n]/)
    }
    expect(formatLine('text', 'info', 'e\nx', {})).not.toMatch(/\n/)
  })
})

describe('AppendFile', () => {
  let dir: string
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const mk = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-log-')))

  it('crea il file con permessi 0600', async () => {
    const file = path.join(mk(), 'audit.log')
    const f = new AppendFile(file)
    f.write('a')
    await f.close()
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('un percorso non scrivibile fallisce subito con ConfigError chiaro', () => {
    mk()
    expect(() => new AppendFile(path.join(dir, 'manca', 'audit.log'))).toThrow(ConfigError)
    expect(() => new AppendFile(path.join(dir, 'manca', 'audit.log'))).toThrow(/AUDIT_LOG_FILE/)
  })

  it('scritture concorrenti: nessuna riga persa né intrecciata', async () => {
    const file = path.join(mk(), 'audit.log')
    const f = new AppendFile(file)
    const N = 2000
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => f.write(`riga-${i}-${'x'.repeat(200)}`)),
      ),
    )
    await f.close()
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(N)
    expect(new Set(lines).size).toBe(N)
    for (const l of lines) expect(l).toMatch(/^riga-\d+-x{200}$/)
  })

  it('reopen: dopo la rotazione scrive sul file nuovo, il vecchio resta completo', async () => {
    const file = path.join(mk(), 'audit.log')
    const f = new AppendFile(file)
    f.write('prima')
    fs.renameSync(file, file + '.1') // logrotate
    expect(f.reopen()).toBe(true)
    f.write('dopo')
    await f.close()
    expect(fs.readFileSync(file + '.1', 'utf8')).toBe('prima\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('dopo\n')
  })

  it('copytruncate è sicuro: il file è aperto in append', async () => {
    const file = path.join(mk(), 'audit.log')
    const f = new AppendFile(file)
    f.write('uno')
    await new Promise((r) => setTimeout(r, 30))
    fs.truncateSync(file, 0)
    f.write('due')
    await f.close()
    expect(fs.readFileSync(file, 'utf8')).toBe('due\n')
  })

  it('reopen che fallisce tiene il vecchio file e non lancia', async () => {
    const file = path.join(mk(), 'sub', 'audit.log')
    fs.mkdirSync(path.dirname(file))
    const errors: string[] = []
    const f = new AppendFile(file, (m) => errors.push(m))
    fs.rmSync(path.dirname(file), { recursive: true })
    expect(f.reopen()).toBe(false)
    expect(errors[0]).toMatch(/AUDIT_LOG_FILE/)
    await f.close()
  })
})
