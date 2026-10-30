import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, frontmatter, makeService, setupService } from './helpers'

let fixture: Awaited<ReturnType<typeof setupService>> | null = null
const extra: string[] = []

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
  for (const d of extra.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8' },
  ).trim()
}

const page = { 'a.md': frontmatter() + '# A' }

describe('wikiStatus: source (freschezza)', () => {
  it('wiki in un repo git: SHA breve e data del commit, senza percorsi né remote', async () => {
    fixture = setupService(page)
    git(fixture.wikiDir, 'init', '-q')
    git(fixture.wikiDir, 'add', '-A')
    git(fixture.wikiDir, 'commit', '-q', '-m', 'v1')

    const st = await fixture.svc.getStatus()
    expect(st.source?.commit).toBe(git(fixture.wikiDir, 'rev-parse', '--short', 'HEAD'))
    expect(st.source?.commitDate).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
    )
    // mai fetch: ultimo sync sconosciuto
    expect(st.source?.syncedAt).toBeNull()
    expect(JSON.stringify(st)).not.toContain(fixture.root)
    expect(st.totalPages).toBe(1)
  })

  it('wiki come sottocartella del repo: usa il HEAD del repo contenitore', async () => {
    fixture = setupService(page, { 'r.md': 'x' })
    git(fixture.root, 'init', '-q')
    git(fixture.root, 'add', '-A')
    git(fixture.root, 'commit', '-q', '-m', 'v1')

    const st = await fixture.svc.getStatus()
    expect(st.source?.commit).toBe(git(fixture.root, 'rev-parse', '--short', 'HEAD'))
  })

  it("syncedAt segue l'mtime di FETCH_HEAD dopo un fetch", async () => {
    fixture = setupService(page)
    git(fixture.root, 'init', '-q')
    git(fixture.root, 'add', '-A')
    git(fixture.root, 'commit', '-q', '-m', 'v1')
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-clone-'))
    extra.push(clone)
    git(clone, 'clone', '-q', fixture.root, 'c')
    const wikiClone = path.join(clone, 'c', 'wiki')
    git(wikiClone, 'fetch', '-q')

    const f2 = makeService(wikiClone, path.join(clone, 'c', 'raw'))
    const st = await f2.getStatus()
    expect(st.source?.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const mtime = fs.statSync(path.join(clone, 'c', '.git', 'FETCH_HEAD')).mtime.toISOString()
    expect(st.source?.syncedAt).toBe(mtime)
  })

  it('wiki fuori da git: campo assente e nessun errore', async () => {
    fixture = setupService(page)
    // la fixture sta in tmpdir, non dentro un repo: nessun git init
    const st = await fixture.svc.getStatus()
    expect(st.source).toBeUndefined()
    expect(st.totalPages).toBe(1)
  })

  it('git non disponibile: campo assente, nessun errore', async () => {
    fixture = setupService(page)
    const oldPath = process.env.PATH
    process.env.PATH = ''
    try {
      const st = await fixture.svc.getStatus()
      expect(st.source).toBeUndefined()
      expect(st.totalPages).toBe(1)
    } finally {
      process.env.PATH = oldPath
    }
  })
})
