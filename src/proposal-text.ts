// Testi che finiscono su GitHub (messaggio di commit, titolo e corpo della PR) a partire da
// valori scritti da un utente remoto: nome utente del token, titolo, motivazione, percorso.
// Qui si neutralizza tutto ciò che potrebbe fare più di «mostrare testo»:
// - newline e altri controlli (un a-capo nel nome utente aprirebbe un trailer `Co-authored-by:`
//   o una riga di intestazione nel messaggio di commit);
// - `@menzioni` (notificherebbero persone o team): un carattere a larghezza zero dopo `@`;
// - riferimenti `#123` (collegherebbero la PR a una issue, e una parola come «closes» la
//   chiuderebbe al merge): stesso trattamento;
// - HTML attivo e markdown di link/immagini (un `![](http://...)` farebbe caricare una risorsa
//   esterna a chi apre la PR): `<`, `>`, `&`, `[`, `]` escapati.

/** Carattere a larghezza zero inserito dopo `@` e `#`. */
export const ZWSP = '\u200b'

const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g

/** Una sola riga: controlli (a-capo compresi) diventano spazio, spazi compressi, troncata a `max`. */
export function oneLine(value: string, max: number): string {
  const flat = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : chars.slice(0, max - 1).join('') + '…'
}

/** Disinnesca `@menzione` e `#numero`. */
export function neutralizeRefs(value: string): string {
  return value.replace(/@/g, `@${ZWSP}`).replace(/#(?=\d)/g, `#${ZWSP}`)
}

/** Escape di ciò che in markdown/HTML ha effetto: `<`, `>`, `&`, `[`, `]`, backtick. */
export function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, "'")
}

/** Testo libero su una riga, pronto per titolo o corpo: una riga, riferimenti e markup neutralizzati. */
export function plainLine(value: string, max: number): string {
  return neutralizeRefs(escapeMarkup(oneLine(value, max)))
}

/** Testo libero su più righe, in blocco citazione; righe e lunghezza limitate. */
export function quoteBlock(value: string, maxChars: number, maxLines = 30): string {
  const lines = value
    .slice(0, maxChars)
    .replace(CONTROL_KEEP_NEWLINE, ' ')
    .split(/\r\n|\r|\n/)
    .slice(0, maxLines)
    .map((l) => l.trim())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return '> (nessuna motivazione)'
  return lines.map((l) => `> ${neutralizeRefs(escapeMarkup(l))}`.trimEnd()).join('\n')
}

const CONTROL_KEEP_NEWLINE =
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g

/** Percorso di una pagina in forma sicura per inline code (il percorso è già validato). */
const code = (value: string): string => `\`${value.replace(/`/g, "'")}\``

export interface ProposalMeta {
  user: string
  principalId: string
  wiki: string
  path: string
  action: 'create' | 'update'
  title?: string
  rationale?: string
  /** Massimo di caratteri della motivazione. */
  maxRationaleChars: number
}

export const TITLE_MAX = 100

const ACTION_LABEL = { create: 'Nuova pagina', update: 'Modifica' } as const

/** Titolo della PR: una riga, con prefisso fisso, senza menzioni. */
export function prTitle(meta: ProposalMeta): string {
  const base = meta.title?.trim()
    ? plainLine(meta.title, TITLE_MAX)
    : `${ACTION_LABEL[meta.action]}: ${meta.path}`
  return `[${meta.wiki}] ${base}`.slice(0, 200)
}

/** Identità del proponente in una riga, per commit e corpo: `utente (id)`. */
export function proposerLabel(user: string, principalId: string): string {
  return `${oneLine(user, 80)} (${oneLine(principalId, 80)})`
}

/**
 * Messaggio di commit: oggetto su una riga, poi il trailer `Proposed-by`. Nome e id sono ridotti
 * a una riga, quindi nessun valore utente può aggiungere altre righe o trailer. `<` e `>` si
 * tolgono (nei trailer delimitano un indirizzo email).
 */
export function commitMessage(meta: ProposalMeta): string {
  const subject = oneLine(`${ACTION_LABEL[meta.action]}: ${meta.path}`, 120)
  const who = proposerLabel(meta.user, meta.principalId).replace(/[<>]/g, '')
  return `${subject}\n\nProposed-by: ${who}`
}

/** Corpo della PR: proponente, wiki, percorso, azione, motivazione citata e nota di non-revisione. */
export function prBody(meta: ProposalMeta): string {
  const who = neutralizeRefs(escapeMarkup(proposerLabel(meta.user, meta.principalId)))
  return [
    `Proposed-by: ${who}`,
    '',
    `- Wiki: ${code(meta.wiki)}`,
    `- Pagina: ${code(meta.path)}`,
    `- Azione: ${meta.action === 'create' ? 'creazione di una pagina nuova' : 'modifica di una pagina esistente'}`,
    '',
    '### Motivazione',
    '',
    quoteBlock(meta.rationale ?? '', meta.maxRationaleChars),
    '',
    '---',
    'Questa pull request è stata generata dal tool `wikiProposePage` su richiesta di un client remoto e **non è stata ancora rivista**: il contenuto proviene da un agente o da una persona che non ha accesso diretto al repository. Va letta come qualunque altra modifica prima del merge; il merge lo fa una persona.',
  ].join('\n')
}

/** Frammento adatto a un nome di branch: ASCII minuscolo, trattini, al massimo `max` caratteri. */
export function slug(value: string, max: number): string {
  const s = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s || 'x'
}
