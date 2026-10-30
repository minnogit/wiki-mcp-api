import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISABLED_AUDITOR } from '../src/audit.js'
import { ConfigError } from '../src/config.js'
import { createTelemetryFromEnv } from '../src/telemetry.js'
import { cleanup, frontmatter, setupService } from './helpers'
import { SECRET_CONTENT, type Ev } from './obs-helpers'

let dir = ''
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = ''
})
const mk = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-tel-')))

describe('createTelemetryFromEnv', () => {
  it('HTTP: audit attivo sullo stesso stream del logger', () => {
    const lines: string[] = []
    const t = createTelemetryFromEnv({}, 'http', (l) => lines.push(l))
    expect(t.auditor.enabled).toBe(true)
    t.auditor.record('audit', { tool: 'x' })
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'audit', tool: 'x' })
  })

  it('stdio: audit spento di default, acceso solo con AUDIT_LOG_FILE', async () => {
    expect(createTelemetryFromEnv({}, 'stdio').auditor).toBe(DISABLED_AUDITOR)
    const file = path.join(mk(), 'a.log')
    const t = createTelemetryFromEnv({ AUDIT_LOG_FILE: file }, 'stdio')
    expect(t.auditor.enabled).toBe(true)
    t.auditor.record('audit', { tool: 'x' })
    await t.auditor.close()
    expect(fs.readFileSync(file, 'utf8')).toContain('"tool":"x"')
  })

  it('AUDIT_LOG_FILE: JSON sul file (non sullo stream), richieste concorrenti senza perdite, reopen', async () => {
    const file = path.join(mk(), 'audit.log')
    const lines: string[] = []
    const t = createTelemetryFromEnv({ AUDIT_LOG_FILE: file, LOG_FORMAT: 'text' }, 'http', (l) =>
      lines.push(l),
    )
    await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        Promise.resolve().then(() => t.auditor.record('audit', { i })),
      ),
    )
    fs.renameSync(file, file + '.1')
    expect(t.auditor.reopen()).toBe(true)
    t.auditor.record('audit', { i: 'dopo' })
    await t.auditor.close()
    expect(lines).toEqual([])
    const old = fs
      .readFileSync(file + '.1', 'utf8')
      .trim()
      .split('\n')
    expect(old).toHaveLength(500)
    expect(new Set(old.map((l) => (JSON.parse(l) as { i: number }).i)).size).toBe(500)
    expect(fs.readFileSync(file, 'utf8')).toContain('"i":"dopo"')
  })

  it('file non scrivibile: ConfigError all avvio, non a runtime', () => {
    mk()
    expect(() =>
      createTelemetryFromEnv({ AUDIT_LOG_FILE: path.join(dir, 'no', 'audit.log') }, 'http'),
    ).toThrow(ConfigError)
  })

  it('AUDIT_QUERY_MAX_CHARS configura il troncamento (valori non validi: default)', () => {
    expect(createTelemetryFromEnv({ AUDIT_QUERY_MAX_CHARS: '20' }, 'http').queryMaxChars).toBe(20)
    expect(createTelemetryFromEnv({ AUDIT_QUERY_MAX_CHARS: 'x' }, 'http').queryMaxChars).toBe(100)
  })
})

// Lo stdio vero, come lo lancia un client MCP: stdout deve contenere solo messaggi JSON-RPC.
describe('stdio: stdout è solo protocollo MCP', () => {
  it('nessuna riga di log su stdout; con AUDIT_LOG_FILE l audit va sul file con principal local', async () => {
    const fx = setupService({ 'concetti/uno.md': frontmatter() + '# Uno\n\nTesto.\n' })
    mk()
    const auditFile = path.join(dir, 'audit.log')
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/stdio.ts'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          PATH: process.env.PATH,
          WIKI_PATH: fx.wikiDir,
          RAW_PATH: fx.rawDir,
          LOG_LEVEL: 'debug',
          AUDIT_LOG_FILE: auditFile,
        },
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n')
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'wikiWritePage',
          arguments: {
            path: 'concetti/due.md',
            content: frontmatter() + `# D\n\n${SECRET_CONTENT}\n`,
          },
        },
      })
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'wikiSearch', arguments: { q: 'uno' } },
      })
      const deadline = Date.now() + 20_000
      while (!/"id":4/.test(out) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50))
      child.kill('SIGTERM')
      await new Promise((r) => child.once('close', r))

      const rows = out.split('\n').filter(Boolean)
      expect(rows.length).toBeGreaterThanOrEqual(4)
      for (const row of rows) {
        const msg = JSON.parse(row) as { jsonrpc?: string }
        expect(msg.jsonrpc).toBe('2.0')
      }
      expect(out).not.toContain('"event"')
      expect(err).not.toContain(SECRET_CONTENT)

      await new Promise((r) => setTimeout(r, 100))
      const audit = fs
        .readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Ev)
      expect(audit.map((e) => e.tool).sort()).toEqual(['wikiSearch', 'wikiWritePage'])
      expect(audit.every((e) => e.principal.id === 'local' && e.outcome === 'ok')).toBe(true)
      expect(fs.readFileSync(auditFile, 'utf8')).not.toContain(SECRET_CONTENT)
    } finally {
      cleanup(fx)
    }
  }, 40_000)

  it('senza AUDIT_LOG_FILE l audit è spento: nessun evento audit da nessuna parte', async () => {
    const fx = setupService({ 'concetti/uno.md': frontmatter() + '# Uno\n' })
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/stdio.ts'], {
        cwd: path.resolve(__dirname, '..'),
        env: { PATH: process.env.PATH, WIKI_PATH: fx.wikiDir, RAW_PATH: fx.rawDir },
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n')
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'wikiStatus', arguments: {} },
      })
      const deadline = Date.now() + 20_000
      while (!/"id":2/.test(out) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50))
      child.kill('SIGTERM')
      await new Promise((r) => child.once('close', r))
      expect(out).not.toContain('audit')
      expect(err).not.toContain('audit')
    } finally {
      cleanup(fx)
    }
  }, 40_000)
})
