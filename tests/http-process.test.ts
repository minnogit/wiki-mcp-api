import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, it } from 'vitest'
import { cleanup, frontmatter, setupService } from './helpers'

async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as net.AddressInfo
  await new Promise((r) => srv.close(r))
  return port
}

// Il processo vero (src/http.ts): audit su file, riapertura con SIGHUP come fa logrotate,
// uscita pulita con SIGTERM.
it('http.ts: AUDIT_LOG_FILE con SIGHUP dopo la rotazione, SIGTERM pulito, stdout in JSON', async () => {
  const fx = setupService({ 'concetti/uno.md': frontmatter() + '# Uno\n' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-proc-'))
  const file = path.join(dir, 'audit.log')
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      WIKI_PATH: fx.wikiDir,
      RAW_PATH: fx.rawDir,
      MCP_HTTP_TOKEN: 'tok-processo',
      MCP_HTTP_PORT: String(port),
      AUDIT_LOG_FILE: file,
    },
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  try {
    const until = async (cond: () => boolean) => {
      const end = Date.now() + 20_000
      while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 30))
      expect(cond()).toBe(true)
    }
    await until(() => out.includes('"event":"startup"') && out.includes('Autenticazione'))
    await fetch(`http://127.0.0.1:${port}/mcp`)
    await until(
      () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('missing-token'),
    )
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    fs.renameSync(file, file + '.1')
    child.kill('SIGHUP')
    await until(() => out.includes('"event":"reload"'))
    await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: 'Bearer sbagliato' } })
    await until(
      () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('invalid-token'),
    )
    expect(fs.readFileSync(file + '.1', 'utf8')).toContain('missing-token')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('missing-token')

    const exit = new Promise<number | null>((r) => child.once('close', r))
    child.kill('SIGTERM')
    expect(await exit).toBe(0)
    // ogni riga di stdout è un oggetto JSON con ts, level, event; e l'audit non è finito qui
    for (const row of out.split('\n').filter(Boolean)) {
      const e = JSON.parse(row) as { ts: string; level: string; event: string }
      expect(typeof e.ts + typeof e.level + typeof e.event).toBe('stringstringstring')
    }
    expect(out).not.toContain('"event":"auth"')
    expect(out).not.toContain('tok-processo')
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
    cleanup(fx)
  }
}, 60_000)
