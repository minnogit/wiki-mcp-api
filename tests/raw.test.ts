import * as crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, setupService } from './helpers'

let fixture: Awaited<ReturnType<typeof setupService>> | null = null

async function init(files: Record<string, string> = {}, raw: Record<string, string> = {}) {
  fixture = await setupService(files, raw)
  return { svc: fixture.svc, rawDir: fixture.rawDir }
}

afterEach(() => {
  if (fixture) cleanup(fixture)
  fixture = null
})

const sha12 = (content: string): string =>
  crypto.createHash('sha256').update(Buffer.from(content)).digest('hex').slice(0, 12)

describe('readRaw / listRaw', () => {
  it('legge e lista i file raw con checksum', async () => {
    const { svc } = await init({}, { 'sorgente.txt': 'dati grezzi' })
    expect(await svc.readRaw('sorgente.txt')).toBe('dati grezzi')
    const list = await svc.listRaw()
    expect(list).toEqual([{ filename: 'sorgente.txt', checksum: sha12('dati grezzi') }])
  })

  it('rifiuta traversal e filename mancanti', async () => {
    const { svc } = await init()
    await expect(svc.readRaw('../fuori.txt')).rejects.toThrow('non valido')
    await expect(svc.readRaw('sub/in.txt')).rejects.toThrow('non valido')
    await expect(svc.readRaw('assente.txt')).rejects.toThrow('File raw non trovato')
  })

  it('raw/ assente equivale a lista vuota', async () => {
    fixture = await setupService()
    fixture.svc // module loaded
    const { rmSync } = await import('node:fs')
    rmSync(fixture.rawDir, { recursive: true })
    expect(await fixture.svc.listRaw()).toEqual([])
  })
})

describe('fileChecksum', () => {
  it('accetta path relativi a wiki/ e raw/', async () => {
    const { svc } = await init({ 'p.md': 'contenuto wiki' }, { 's.txt': 'contenuto raw' })
    expect(await svc.fileChecksum('p.md')).toBe(sha12('contenuto wiki'))
    expect(await svc.fileChecksum('s.txt')).toBe(sha12('contenuto raw'))
  })

  it('in caso di omonimia vince la copia in wiki/', async () => {
    const { svc } = await init({ 'dup.dat': 'versione wiki' }, { 'dup.dat': 'versione raw' })
    expect(await svc.fileChecksum('dup.dat')).toBe(sha12('versione wiki'))
  })

  it('rifiuta path assoluti, traversal e file inesistenti', async () => {
    const { svc } = await init()
    await expect(svc.fileChecksum('/etc/passwd')).rejects.toThrow('Solo path relativi')
    await expect(svc.fileChecksum('../../etc/passwd')).rejects.toThrow()
    await expect(svc.fileChecksum('assente.md')).rejects.toThrow('File non trovato')
  })
})
