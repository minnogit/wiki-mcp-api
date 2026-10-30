import { describe, expect, it } from 'vitest'
import type { Principal } from '../src/auth.js'
import { LEGACY_PRINCIPAL } from '../src/auth.js'
import {
  ADMIN_GROUP,
  authorize,
  canRead,
  canWrite,
  parseAccess,
  visibleTo,
  type AccessFields,
} from '../src/wiki/access.js'

const p = (groups: string[]): Principal => ({ id: 'x', user: 'x', groups, wikis: '*' })
const rh = p(['hr'])
const rest = p(['it'])
const nessuno = p([])
const admin = p([ADMIN_GROUP])

describe('canRead / canWrite: matrice delle regole', () => {
  // [descrizione, campi, chi vede]
  const CASES: [string, AccessFields, { hr: boolean; it: boolean; nessuno: boolean }][] = [
    ['campo assente', {}, { hr: true, it: true, nessuno: true }],
    ['pubblica', { visibilita: 'pubblica' }, { hr: true, it: true, nessuno: true }],
    ['interna', { visibilita: 'interna' }, { hr: true, it: true, nessuno: true }],
    [
      'pubblica con gruppi (nessun effetto)',
      { visibilita: 'pubblica', gruppi: ['hr'] },
      { hr: true, it: true, nessuno: true },
    ],
    [
      'interna con gruppi (nessun effetto)',
      { visibilita: 'interna', gruppi: ['hr'] },
      { hr: true, it: true, nessuno: true },
    ],
    [
      'gruppi senza visibilita (nessun effetto)',
      { gruppi: ['hr'] },
      { hr: true, it: true, nessuno: true },
    ],
    [
      'riservata con gruppi',
      { visibilita: 'riservata', gruppi: ['hr', 'legal'] },
      { hr: true, it: false, nessuno: false },
    ],
    [
      'riservata senza gruppi: solo admin',
      { visibilita: 'riservata' },
      { hr: false, it: false, nessuno: false },
    ],
    [
      'riservata con gruppi vuoti: solo admin',
      { visibilita: 'riservata', gruppi: [] },
      { hr: false, it: false, nessuno: false },
    ],
    [
      'valore sconosciuto: fail-closed come riservata',
      { visibilita: 'riservta', gruppi: ['hr'] },
      { hr: true, it: false, nessuno: false },
    ],
    [
      'valore sconosciuto senza gruppi: solo admin',
      { visibilita: 'Pubblica' },
      { hr: false, it: false, nessuno: false },
    ],
    ['stringa vuota: fail-closed', { visibilita: '' }, { hr: false, it: false, nessuno: false }],
  ]

  it.each(CASES)('%s', (_name, fields, expected) => {
    expect(canRead(fields, rh)).toBe(expected.hr)
    expect(canRead(fields, rest)).toBe(expected.it)
    expect(canRead(fields, nessuno)).toBe(expected.nessuno)
    // admin e locale vedono sempre tutto
    expect(canRead(fields, admin)).toBe(true)
    expect(canRead(fields, undefined)).toBe(true)
    // oggi la scrittura ha la stessa regola
    for (const who of [rh, rest, nessuno, admin, undefined]) {
      expect(canWrite(fields, who)).toBe(canRead(fields, who))
    }
  })

  it('il principal legacy non ha gruppi: non vede le riservate; con admin sì', () => {
    expect(LEGACY_PRINCIPAL.groups).toEqual([])
    expect(canRead({ visibilita: 'riservata', gruppi: ['hr'] }, LEGACY_PRINCIPAL)).toBe(false)
    expect(canRead({ visibilita: 'riservata' }, LEGACY_PRINCIPAL)).toBe(false)
    expect(canRead({ visibilita: 'interna' }, LEGACY_PRINCIPAL)).toBe(true)
    expect(canRead({ visibilita: 'riservata' }, { ...LEGACY_PRINCIPAL, groups: ['admin'] })).toBe(
      true,
    )
  })

  it('accetta una pagina (oggetto con frontmatter) oltre ai soli campi', () => {
    const page = { frontmatter: { visibilita: 'riservata', gruppi: ['hr'] } }
    expect(canRead(page, rh)).toBe(true)
    expect(canRead(page, rest)).toBe(false)
  })

  it('il confronto dei gruppi è esatto (maiuscole e prefissi non contano)', () => {
    const f = { visibilita: 'riservata', gruppi: ['hr'] }
    expect(canRead(f, p(['HR']))).toBe(false)
    expect(canRead(f, p(['hr-extra']))).toBe(false)
    expect(canRead(f, p(['Admin']))).toBe(false)
  })

  it('un gruppo `admin` elencato in gruppi non apre ad altri', () => {
    expect(canRead({ visibilita: 'riservata', gruppi: ['admin'] }, rest)).toBe(false)
    expect(canRead({ visibilita: 'riservata', gruppi: ['admin'] }, admin)).toBe(true)
  })
})

describe('authorize: motivo del rifiuto (vocabolario chiuso)', () => {
  it('visibility per riservata, visibility-invalid per valore sconosciuto', () => {
    expect(authorize({ visibilita: 'riservata' }, rest)).toEqual({
      allowed: false,
      reason: 'visibility',
    })
    expect(authorize({ visibilita: 'riservta' }, rest)).toEqual({
      allowed: false,
      reason: 'visibility-invalid',
    })
    expect(authorize({ visibilita: 'pubblica' }, rest)).toEqual({ allowed: true })
  })
})

describe('visibleTo', () => {
  it('filtra una lista per principal', () => {
    const pages = [
      { slug: 'a', frontmatter: {} },
      { slug: 'b', frontmatter: { visibilita: 'riservata', gruppi: ['hr'] } },
      { slug: 'c', frontmatter: { visibilita: 'riservata' } },
    ]
    expect(pages.filter(visibleTo(rh)).map((x) => x.slug)).toEqual(['a', 'b'])
    expect(pages.filter(visibleTo(rest)).map((x) => x.slug)).toEqual(['a'])
    expect(pages.filter(visibleTo(admin)).map((x) => x.slug)).toEqual(['a', 'b', 'c'])
    expect(pages.filter(visibleTo(undefined)).map((x) => x.slug)).toEqual(['a', 'b', 'c'])
  })
})

describe('parseAccess', () => {
  it('campi assenti: nessuna visibilita, gruppi vuoti', () => {
    expect(parseAccess({})).toEqual({ gruppi: [] })
  })
  it('valori validi', () => {
    expect(parseAccess({ visibilita: 'riservata', gruppi: ['hr', ' legal ', 'hr', ''] })).toEqual({
      visibilita: 'riservata',
      gruppi: ['hr', 'legal'],
    })
  })
  it('valore sconosciuto: riservata e segnalato', () => {
    expect(parseAccess({ visibilita: 'riservta' })).toEqual({
      visibilita: 'riservata',
      gruppi: [],
      visibilitaNonValida: 'riservta',
    })
    expect(parseAccess({ visibilita: 5 }).visibilita).toBe('riservata')
    expect(parseAccess({ visibilita: null })).toMatchObject({
      visibilita: 'riservata',
      visibilitaNonValida: 'null',
    })
    expect(parseAccess({ visibilita: ['pubblica'] }).visibilita).toBe('riservata')
  })
  it('gruppi che non è una lista vale vuoto', () => {
    expect(parseAccess({ visibilita: 'riservata', gruppi: 'hr' }).gruppi).toEqual([])
    expect(parseAccess({ gruppi: { hr: true } }).gruppi).toEqual([])
    expect(parseAccess({ gruppi: null }).gruppi).toEqual([])
  })
})
