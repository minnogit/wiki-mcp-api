// Ricerca testuale in memoria: normalizzazione, stemming leggero italiano, ranking TF-IDF
// per campo (titolo > tag > contenuto), frasi tra virgolette, tolleranza ai refusi lievi e
// snippet. Nessuna dipendenza e nessun indice su disco: l'indice di ogni pagina vive in una
// WeakMap legata all'oggetto Page che la cache di service.ts (mtime+size) restituisce, quindi
// si invalida insieme a lei: una pagina modificata è un nuovo oggetto, una eliminata viene
// raccolta dal GC. Nessun ricalcolo a ogni chiamata.

export interface SearchablePage {
  title: string
  frontmatter: { tags: string[] }
  content: string
}

const STOPWORDS_RAW = [
  'di',
  'a',
  'da',
  'in',
  'con',
  'su',
  'per',
  'tra',
  'fra',
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una',
  'del',
  'dello',
  'della',
  'dei',
  'degli',
  'delle',
  'al',
  'allo',
  'alla',
  'ai',
  'agli',
  'alle',
  'dal',
  'dallo',
  'dalla',
  'dai',
  'dagli',
  'dalle',
  'nel',
  'nello',
  'nella',
  'nei',
  'negli',
  'nelle',
  'che',
  'e',
  'o',
  'ma',
  'se',
  'come',
  'anche',
  'non',
  'più',
  'meno',
  'si',
  'ci',
  'ne',
  'è',
]

// Minuscole e senza accenti, SENZA cambiare la lunghezza della stringa (un carattere in,
// un carattere fuori): così gli indici trovati sul testo normalizzato valgono anche sul
// testo originale, e lo snippet può essere tagliato da quello.
export function fold(text: string): string {
  return text.toLowerCase().replace(/[^\u0000-\u007f]/g, (ch) => ch.normalize('NFD')[0] ?? ch)
}

const STOPWORDS = new Set(STOPWORDS_RAW.map(fold))

// Aggiunge le preposizioni articolate elise («dell'articolo» -> «dell» + «articolo»).
for (const w of ['dell', 'nell', 'sull', 'dall', 'all', 'quest', 'quell', 'un', 'd', 'l'])
  STOPWORDS.add(w)

// Stemming leggero italiano, scritto a mano: toglie la desinenza vocalica (fattura/fatture,
// articolo/articoli, negozio/negozi) e riduce -che/-chi, -ghe/-ghi alla radice (banca/banche).
// Volutamente grossolano: serve a far incontrare singolare/plurale e maschile/femminile,
// non è un analizzatore morfologico. Radici sotto i 3 caratteri e token con cifre restano intatti.
export function stem(token: string): string {
  if (token.length < 4 || /\d/.test(token)) return token
  let s = token
  if (/(?:ch|gh)[ei]$/.test(s)) s = s.slice(0, -2)
  else {
    if (/[aeiou]$/.test(s)) s = s.slice(0, -1)
    if (s.length > 3 && s.endsWith('i')) s = s.slice(0, -1)
  }
  return s.length >= 3 ? s : token
}

// Token normalizzati e stemmati, senza stopword.
export function tokenize(text: string): string[] {
  const matches = fold(text).match(/[a-z0-9]+/g) ?? []
  return matches.filter((t) => t.length > 1 && !STOPWORDS.has(t)).map(stem)
}

interface DocIndex {
  title: Map<string, number>
  tags: Map<string, number>
  content: Map<string, number>
  // sequenze di stem separate da spazi (con spazio iniziale e finale), per la ricerca di frase
  titleSeq: string
  contentSeq: string
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

const seq = (tokens: string[]): string => ` ${tokens.join(' ')} `

const indexCache = new WeakMap<object, DocIndex>()

function getIndex(page: SearchablePage): DocIndex {
  let idx = indexCache.get(page)
  if (!idx) {
    const title = tokenize(page.title)
    const content = tokenize(page.content)
    idx = {
      title: termCounts(title),
      tags: termCounts(tokenize(page.frontmatter.tags.join(' '))),
      content: termCounts(content),
      titleSeq: seq(title),
      contentSeq: seq(content),
    }
    indexCache.set(page, idx)
  }
  return idx
}

const has = (idx: DocIndex, term: string): boolean =>
  idx.title.has(term) || idx.tags.has(term) || idx.content.has(term)

const FIELD_WEIGHTS = { title: 4, tags: 3, content: 1 }
// Peso dei termini trovati per tolleranza al refuso rispetto a quelli scritti giusti.
const FUZZY_WEIGHT = 0.5

// Frase tra virgolette dritte, alla francese o inglesi.
const PHRASE_RE = /"([^"]+)"|«([^»]+)»|“([^”]+)”/g

export interface ParsedQuery {
  // stem dei termini liberi e di quelli delle frasi, senza duplicati
  terms: string[]
  // stem di ogni frase tra virgolette: una pagina deve contenerli di seguito
  phrases: string[][]
}

export function parseQuery(q: string): ParsedQuery {
  const phrases: string[][] = []
  const free = q.replace(PHRASE_RE, (_m, a?: string, b?: string, c?: string) => {
    const tokens = tokenize(a ?? b ?? c ?? '')
    if (tokens.length > 0) phrases.push(tokens)
    return ' '
  })
  const terms = [...new Set([...tokenize(free), ...phrases.flat()])]
  return { terms, phrases }
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true // sostituzione
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2) // scambio
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a]
  return long.slice(i + 1) === short.slice(i) // inserimento/cancellazione
}

// Termini del vocabolario a distanza di edit 1 (o uno scambio di due lettere) da quello cercato (che non compare in nessuna
// pagina). Solo per parole di almeno 5 lettere e con la stessa iniziale: sono i refusi che
// costano poco da gestire e danno pochi falsi positivi.
function fuzzyMatches(term: string, indexes: DocIndex[]): string[] {
  if (term.length < 5) return []
  const found = new Set<string>()
  for (const idx of indexes)
    for (const map of [idx.title, idx.tags, idx.content])
      for (const candidate of map.keys())
        if (candidate[0] === term[0] && candidate !== term && withinOneEdit(candidate, term))
          found.add(candidate)
  return [...found]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const SNIPPET_CONTEXT_CHARS = 60

// `patterns` sono sorgenti di regex da cercare nel testo normalizzato (fold): le posizioni
// valgono anche per il testo originale, da cui si taglia lo snippet.
function buildSnippet(content: string, patterns: string[]): string | undefined {
  if (patterns.length === 0) return undefined
  const match = new RegExp(`(?<![a-z0-9])(?:${patterns.join('|')})`).exec(fold(content))
  if (!match) return undefined

  const start = Math.max(0, match.index - SNIPPET_CONTEXT_CHARS)
  const end = Math.min(content.length, match.index + match[0].length + SNIPPET_CONTEXT_CHARS)
  const body = content.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < content.length ? '…' : '')
}

export interface RankedPage<P> {
  page: P
  score: number
  snippet?: string
}

// Ranking TF-IDF per campo su `candidates` (le pagine già filtrate per tag/tipo/stato);
// il corpus per IDF e vocabolario è `allPages`. Restituisce null se la query non ha token
// utili (solo stopword/simboli): il chiamante ripiega sul substring match.
export function rankPages<P extends SearchablePage>(
  allPages: P[],
  candidates: P[],
  q: string,
): RankedPage<P>[] | null {
  const { terms, phrases } = parseQuery(q)
  if (terms.length === 0) return null

  const indexes = new Map(allPages.map((p) => [p, getIndex(p)] as const))
  const docFreq = (term: string): number => {
    let df = 0
    for (const idx of indexes.values()) if (has(idx, term)) df++
    return df
  }

  const weighted: { term: string; weight: number; df: number }[] = []
  for (const term of terms) {
    const df = docFreq(term)
    if (df > 0) {
      weighted.push({ term, weight: 1, df })
      continue
    }
    for (const fuzzy of fuzzyMatches(term, [...indexes.values()]))
      weighted.push({ term: fuzzy, weight: FUZZY_WEIGHT, df: docFreq(fuzzy) })
  }

  const phraseSeqs = phrases.map((p) => ` ${p.join(' ')} `)
  const patterns = [
    ...phrases.map((p) => p.map(escapeRegex).join('[^a-z0-9]+')),
    ...weighted.map((w) => escapeRegex(w.term)),
  ]

  // tf sublineare per campo: ripetere una parola cento volte nel corpo non deve battere
  // una pagina che la ha nel titolo
  const sub = (c: number | undefined): number => (c ? 1 + Math.log(c) : 0)

  const ranked: RankedPage<P>[] = []
  for (const page of candidates) {
    const idx = indexes.get(page) ?? getIndex(page)
    if (phraseSeqs.some((s) => !idx.titleSeq.includes(s) && !idx.contentSeq.includes(s))) continue

    let score = 0
    for (const { term, weight, df } of weighted) {
      const idf = Math.log(1 + allPages.length / df)
      const tf =
        FIELD_WEIGHTS.title * sub(idx.title.get(term)) +
        FIELD_WEIGHTS.tags * sub(idx.tags.get(term)) +
        FIELD_WEIGHTS.content * sub(idx.content.get(term))
      score += weight * tf * idf
    }
    if (score > 0) ranked.push({ page, score, snippet: buildSnippet(page.content, patterns) })
  }
  return ranked.sort((a, b) => b.score - a.score)
}

// Query senza token utili: substring match (senza accenti né maiuscole) su titolo, tag e corpo.
export function substringMatches<P extends SearchablePage>(
  candidates: P[],
  q: string,
): RankedPage<P>[] {
  const needle = fold(q)
  const pattern = [escapeRegex(needle)]
  return candidates
    .filter((p) => fold([p.title, p.content, ...p.frontmatter.tags].join(' ')).includes(needle))
    .map((page) => ({ page, score: 0, snippet: buildSnippet(page.content, pattern) }))
}
