import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigError,
  DEFAULT_WIKI_NAME,
  loadWikiConfigFile,
  loadWikis,
  parseWikiConfig,
  selectWiki,
} from '../src/config.js'

const BASE = path.resolve('/srv/wikis')

describe('parseWikiConfig', () => {
  it('accetta una lista di wiki e mantiene i campi', () => {
    const wikis = parseWikiConfig(
      [
        {
          name: 'hr',
          wikiPath: '/data/hr/wiki',
          rawPath: '/data/hr/raw',
          domain: '  Risorse umane.  ',
          tz: 'Europe/Rome',
        },
        { name: 'it-2', wikiPath: '/data/it/wiki' },
      ],
      BASE,
    )
    expect(wikis).toEqual([
      {
        name: 'hr',
        wikiDir: '/data/hr/wiki',
        rawDir: '/data/hr/raw',
        domain: 'Risorse umane.',
        tz: 'Europe/Rome',
      },
      {
        name: 'it-2',
        wikiDir: '/data/it/wiki',
        rawDir: undefined,
        domain: undefined,
        tz: undefined,
      },
    ])
  })

  it('rawPath assente: rawDir resta undefined', () => {
    const [w] = parseWikiConfig([{ name: 'a', wikiPath: '/x' }], BASE)
    expect(w.rawDir).toBeUndefined()
  })

  it('risolve i percorsi relativi rispetto alla cartella del file di configurazione', () => {
    const [w] = parseWikiConfig([{ name: 'a', wikiPath: 'a/wiki', rawPath: '../raw-a' }], BASE)
    expect(w.wikiDir).toBe(path.join(BASE, 'a/wiki'))
    expect(w.rawDir).toBe(path.resolve(BASE, '../raw-a'))
  })

  it.each(['HR', 'hr_1', 'a b', 'a.b', 'è', '', 'a/b'])(
    'rifiuta il nome non valido "%s"',
    (name) => {
      expect(() => parseWikiConfig([{ name, wikiPath: '/x' }], BASE)).toThrow(ConfigError)
      expect(() => parseWikiConfig([{ name, wikiPath: '/x' }], BASE)).toThrow(/0\.name/)
    },
  )

  it('rifiuta i nomi duplicati indicando la posizione', () => {
    const cfg = [
      { name: 'a', wikiPath: '/x' },
      { name: 'b', wikiPath: '/y' },
      { name: 'a', wikiPath: '/z' },
    ]
    expect(() => parseWikiConfig(cfg, BASE)).toThrow(/2\.name: nome duplicato "a"/)
  })

  it('rifiuta lista vuota, non-array, campi mancanti, sconosciuti o di tipo sbagliato', () => {
    for (const bad of [
      [],
      {},
      'hr',
      null,
      [{ name: 'a' }],
      [{ name: 'a', wikiPath: '' }],
      [{ name: 'a', wikiPath: '/x', rawPath: '' }],
      [{ name: 'a', wikiPath: '/x', extra: 1 }],
      [{ name: 'a', wikiPath: 3 }],
      [{ name: 'a', wikiPath: '/x', tz: 'Non/Esiste' }],
    ]) {
      expect(() => parseWikiConfig(bad, BASE)).toThrow(/WIKI_CONFIG non valido/)
    }
  })
})

describe('loadWikiConfigFile / loadWikis', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function configFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-mcp-cfg-'))
    dirs.push(dir)
    const file = path.join(dir, 'wikis.json')
    fs.writeFileSync(file, content)
    return file
  }

  it('legge il file e risolve i percorsi relativi rispetto alla sua cartella', () => {
    const file = configFile(
      JSON.stringify([{ name: 'hr', wikiPath: 'hr/wiki', rawPath: 'hr/raw' }]),
    )
    const [w] = loadWikiConfigFile(file)
    expect(w.wikiDir).toBe(path.join(path.dirname(file), 'hr/wiki'))
    expect(w.rawDir).toBe(path.join(path.dirname(file), 'hr/raw'))
  })

  it('errori chiari per file mancante e JSON non valido', () => {
    expect(() => loadWikiConfigFile('/non/esiste/wikis.json')).toThrow(/impossibile leggere/)
    expect(() => loadWikiConfigFile(configFile('{ non json'))).toThrow(/non è JSON valido/)
  })

  it('con WIKI_CONFIG ignora WIKI_PATH/RAW_PATH/WIKI_DOMAIN/WIKI_TZ', () => {
    const file = configFile(JSON.stringify([{ name: 'hr', wikiPath: '/hr/wiki' }]))
    const wikis = loadWikis({
      WIKI_CONFIG: file,
      WIKI_PATH: '/altro/wiki',
      RAW_PATH: '/altro/raw',
      WIKI_DOMAIN: 'ignorato',
      WIKI_TZ: 'UTC',
    })
    expect(wikis).toEqual([
      { name: 'hr', wikiDir: '/hr/wiki', rawDir: undefined, domain: undefined, tz: undefined },
    ])
  })

  it('retrocompatibilità: senza WIKI_CONFIG una sola wiki "default" dalle variabili storiche', () => {
    const wikis = loadWikis({
      WIKI_PATH: '/w/wiki',
      RAW_PATH: '/w/raw',
      WIKI_DOMAIN: ' Dominio X. ',
      WIKI_TZ: 'Europe/Rome',
    })
    expect(wikis).toEqual([
      {
        name: DEFAULT_WIKI_NAME,
        wikiDir: '/w/wiki',
        rawDir: '/w/raw',
        domain: 'Dominio X.',
        tz: 'Europe/Rome',
      },
    ])
  })

  it('retrocompatibilità: senza nessuna variabile usa ./wiki e ./raw dalla cartella corrente', () => {
    const [w] = loadWikis({})
    expect(w.name).toBe('default')
    expect(w.wikiDir).toBe(path.resolve('./wiki'))
    expect(w.rawDir).toBe(path.resolve('./raw'))
    expect(w.domain).toBeUndefined()
    expect(w.tz).toBeUndefined()
    // anche con valori vuoti, come in un .env con le chiavi senza valore
    expect(loadWikis({ WIKI_CONFIG: '  ', WIKI_PATH: '', WIKI_DOMAIN: '  ' })[0]).toMatchObject({
      name: 'default',
      wikiDir: path.resolve('./wiki'),
      domain: undefined,
    })
  })

  it('percorsi relativi in WIKI_PATH/RAW_PATH restano relativi alla cartella corrente', () => {
    const [w] = loadWikis({ WIKI_PATH: 'x/wiki', RAW_PATH: 'x/raw' })
    expect(w.wikiDir).toBe(path.resolve('x/wiki'))
    expect(w.rawDir).toBe(path.resolve('x/raw'))
  })
})

describe('selectWiki (stdio)', () => {
  const ctx = (name: string) => ({ name, wikiDir: `/${name}` })

  it('una wiki sola: non serve WIKI_NAME', () => {
    expect(selectWiki([ctx('default')])).toEqual(ctx('default'))
    expect(selectWiki([ctx('hr')], 'hr')).toEqual(ctx('hr'))
  })

  it('più wiki: WIKI_NAME obbligatoria, con errore che elenca i nomi', () => {
    const wikis = [ctx('hr'), ctx('it')]
    expect(() => selectWiki(wikis)).toThrow(/WIKI_NAME/)
    expect(() => selectWiki(wikis, '  ')).toThrow(/WIKI_NAME/)
    expect(selectWiki(wikis, 'it')).toEqual(ctx('it'))
  })

  it('nome sconosciuto: errore chiaro, anche con una wiki sola', () => {
    expect(() => selectWiki([ctx('hr'), ctx('it')], 'xx')).toThrow(/"xx".*hr, it/)
    expect(() => selectWiki([ctx('hr')], 'xx')).toThrow(/"xx".*hr/)
  })
})
