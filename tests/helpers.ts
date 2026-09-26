import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'

export interface Fixture {
  svc: typeof import('../src/wiki/service.js')
  root: string
  wikiDir: string
  rawDir: string
}

// Il service risolve WIKI_PATH/RAW_PATH al load del modulo: ogni file di test imposta
// le env PRIMA dell'import dinamico e riceve la propria istanza (vitest isola i moduli
// per file, quindi non ci sono collisioni tra suite).
export async function setupService(files: Record<string, string> = {}, rawFiles: Record<string, string> = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-test-'))
  const wikiDir = path.join(root, 'wiki')
  const rawDir = path.join(root, 'raw')
  fs.mkdirSync(wikiDir, { recursive: true })
  fs.mkdirSync(rawDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(wikiDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  for (const [name, content] of Object.entries(rawFiles)) {
    const full = path.join(rawDir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  process.env.WIKI_PATH = wikiDir
  process.env.RAW_PATH = rawDir
  // senza il reset l'import dinamico restituirebbe il modulo già in cache, legato alla fixture precedente
  vi.resetModules()
  const svc = await import('../src/wiki/service.js')
  return { svc, root, wikiDir, rawDir }
}

export function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true })
}

export function frontmatter(opts: Partial<{ tipo: string; tags: string[]; aggiornato: string; stato: string }> = {}): string {
  const { tipo = 'concetto', tags = ['test'], aggiornato = '2026-08-22', stato = 'bozza' } = opts
  return (
    '---\n' +
    `tipo: ${tipo}\n` +
    `tags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n` +
    'fonti: []\n' +
    `aggiornato: "${aggiornato}"\n` +
    `stato: ${stato}\n` +
    '---\n\n'
  )
}
