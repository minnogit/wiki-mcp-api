import * as crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, setupService } from './helpers'

let fixture: Awaited<ReturnType<typeof setupService>> | null = null

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

const sha12 = (content: string | Buffer): string => crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)

// repo git alla radice della fixture: raw/ ne è una sottocartella, come in llm_wiki
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' })
}

async function init(raw: Record<string, string>, opts: { repo?: boolean } = { repo: true }) {
  fixture = await setupService({}, raw)
  if (opts.repo) {
    git(fixture.root, 'init', '-q')
    git(fixture.root, 'add', '-A')
    git(fixture.root, 'commit', '-q', '-m', 'v1')
  }
  return fixture
}

function commitAll(f: { root: string }, msg: string): void {
  git(f.root, 'add', '-A')
  git(f.root, 'commit', '-q', '-m', msg)
}

describe('rawDiff', () => {
  it('con sinceChecksum trova il commit di baseline e mostra tutte le modifiche successive, anche committate', async () => {
    const f = await init({ 'sub/a.md': 'uno\ndue\ntre\n' })
    const baseline = sha12('uno\ndue\ntre\n')
    fs.writeFileSync(path.join(f.rawDir, 'sub/a.md'), 'uno\nDUE\ntre\n')
    commitAll(f, 'v2')
    fs.writeFileSync(path.join(f.rawDir, 'sub/a.md'), 'uno\nDUE\ntre\nquattro\n')
    commitAll(f, 'v3')

    const r = await f.svc.rawDiff('sub/a.md', baseline)
    expect(r.status).toBe('diff')
    if (r.status !== 'diff') return
    expect(r.diff).toContain('-due')
    expect(r.diff).toContain('+DUE')
    expect(r.diff).toContain('+quattro')
  })

  it('senza sinceChecksum mostra le modifiche non committate, altrimenti l\'ultimo commit', async () => {
    const f = await init({ 'a.md': 'uno\n' })
    fs.writeFileSync(path.join(f.rawDir, 'a.md'), 'uno\ndue\n')
    const dirty = await f.svc.rawDiff('a.md')
    expect(dirty.status === 'diff' && dirty.diff).toContain('+due')

    commitAll(f, 'v2')
    const last = await f.svc.rawDiff('a.md')
    expect(last.status === 'diff' && last.diff).toContain('+due')
  })

  it('unchanged se il file coincide con la baseline', async () => {
    const f = await init({ 'a.md': 'uno\n' })
    expect(await f.svc.rawDiff('a.md', sha12('uno\n'))).toEqual({ status: 'unchanged' })
  })

  it('baseline-not-found se nessun commit ha quel checksum', async () => {
    const f = await init({ 'a.md': 'uno\n' })
    expect(await f.svc.rawDiff('a.md', sha12('mai committato'))).toEqual({ status: 'baseline-not-found' })
  })

  it('binary per file binari', async () => {
    const f = await init({ 'x.md': 'x' })
    fs.writeFileSync(path.join(f.rawDir, 'b.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    commitAll(f, 'bin')
    const baseline = sha12(Buffer.from([0, 1, 2, 3, 0, 255]))
    fs.writeFileSync(path.join(f.rawDir, 'b.bin'), Buffer.from([0, 9, 9, 9, 0, 255]))
    expect(await f.svc.rawDiff('b.bin', baseline)).toEqual({ status: 'binary' })
  })

  it('untracked per file non versionati', async () => {
    const f = await init({ 'a.md': 'uno\n' })
    fs.writeFileSync(path.join(f.rawDir, 'nuovo.md'), 'x')
    expect(await f.svc.rawDiff('nuovo.md')).toEqual({ status: 'untracked' })
  })

  it('no-git se raw/ non è in un repo', async () => {
    const f = await init({ 'a.md': 'uno\n' }, { repo: false })
    expect(await f.svc.rawDiff('a.md')).toEqual({ status: 'no-git' })
  })

  it('rifiuta traversal, path assoluti, checksum malformati e file mancanti', async () => {
    const f = await init({ 'a.md': 'uno\n' })
    await expect(f.svc.rawDiff('../fuori.txt')).rejects.toThrow('non valido')
    await expect(f.svc.rawDiff('/etc/passwd')).rejects.toThrow('non valido')
    await expect(f.svc.rawDiff('a.md', '--output=/tmp/x')).rejects.toThrow('sinceChecksum')
    await expect(f.svc.rawDiff('a.md', 'zzzzzzzzzzzz')).rejects.toThrow('sinceChecksum')
    await expect(f.svc.rawDiff('assente.md')).rejects.toThrow('File raw non trovato')
  })

  it('nomi con caratteri glob sono trattati come letterali', async () => {
    const f = await init({ 'a*.md': 'uno\n', 'ab.md': 'altro\n' })
    fs.writeFileSync(path.join(f.rawDir, 'a*.md'), 'uno\ndue\n')
    const r = await f.svc.rawDiff('a*.md')
    expect(r.status === 'diff' && r.diff).toContain('+due')
    expect(r.status === 'diff' && r.diff).not.toContain('altro')
  })
})

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n%\0\0\0\0\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const hasPdftotext = spawnSync('pdftotext', ['-v']).error === undefined

describe('rawDiff su PDF', () => {
  it.skipIf(!hasPdftotext)('con *.pdf diff=pdf in .gitattributes mostra il diff del testo estratto', async () => {
    const f = await init({ 'x.md': 'x' })
    fs.writeFileSync(path.join(f.root, '.gitattributes'), '*.pdf diff=pdf\n')
    const v1 = minimalPdf('versione prima')
    fs.writeFileSync(path.join(f.rawDir, 'doc.pdf'), v1)
    commitAll(f, 'pdf v1')
    fs.writeFileSync(path.join(f.rawDir, 'doc.pdf'), minimalPdf('versione dopo'))

    const r = await f.svc.rawDiff('doc.pdf', sha12(v1))
    expect(r.status).toBe('diff')
    if (r.status !== 'diff') return
    expect(r.diff).toContain('-versione prima')
    expect(r.diff).toContain('+versione dopo')
  })

  it('senza la mappatura in .gitattributes un PDF modificato resta binary', async () => {
    const f = await init({ 'x.md': 'x' })
    const v1 = minimalPdf('prima')
    fs.writeFileSync(path.join(f.rawDir, 'doc.pdf'), v1)
    commitAll(f, 'pdf v1')
    fs.writeFileSync(path.join(f.rawDir, 'doc.pdf'), minimalPdf('dopo'))
    expect(await f.svc.rawDiff('doc.pdf', sha12(v1))).toEqual({ status: 'binary' })
  })
})
