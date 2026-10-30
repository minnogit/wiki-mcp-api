import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWikiService, type WikiService } from '../src/wiki/service.js'

export interface Fixture {
  svc: WikiService
  root: string
  wikiDir: string
  rawDir: string
}

// Ogni fixture crea il proprio service (nessuna env, nessuno stato di modulo): le suite
// possono creare quante wiki vogliono nello stesso processo.
export function makeService(
  wikiDir: string,
  rawDir: string | undefined,
  opts: { name?: string; tz?: string; domain?: string } = {},
): WikiService {
  return createWikiService({ name: opts.name ?? 'test', wikiDir, rawDir, ...opts })
}

export function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

export function setupService(
  files: Record<string, string> = {},
  rawFiles: Record<string, string> = {},
  opts: { tz?: string } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-test-'))
  const wikiDir = path.join(root, 'wiki')
  const rawDir = path.join(root, 'raw')
  fs.mkdirSync(wikiDir, { recursive: true })
  fs.mkdirSync(rawDir, { recursive: true })
  writeTree(wikiDir, files)
  writeTree(rawDir, rawFiles)
  const svc = makeService(wikiDir, rawDir, opts)
  return { svc, root, wikiDir, rawDir }
}

export function cleanup(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true })
}

export function frontmatter(
  opts: Partial<{
    tipo: string
    tags: string[]
    aggiornato: string
    stato: string
    /** righe YAML in più (es. `visibilita: riservata`), accodate prima della chiusura */
    extra: string
  }> = {},
): string {
  const {
    tipo = 'concetto',
    tags = ['test'],
    aggiornato = '2026-08-22',
    stato = 'bozza',
    extra,
  } = opts
  return (
    '---\n' +
    `tipo: ${tipo}\n` +
    `tags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n` +
    'fonti: []\n' +
    `aggiornato: "${aggiornato}"\n` +
    `stato: ${stato}\n` +
    (extra ? `${extra}\n` : '') +
    '---\n\n'
  )
}
