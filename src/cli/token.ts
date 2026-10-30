import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ConfigError } from '../config.js'
import { loadTokenFile, parseTokenFile, writeTokenFile, type TokenEntry } from '../token-file.js'

/** Prefisso riconoscibile (e cercabile da uno scanner di segreti) dei token generati. */
export const TOKEN_PREFIX = 'wmcp_'

const USAGE = `Uso:
  npm run token -- create --user <utente> --wikis <a,b|*> [--groups g1,g2]
                          [--expires <data ISO>] [--id <id>] [--note <testo>] [--file <percorso>]
  npm run token -- list [--file <percorso>]
  npm run token -- revoke <id> [--file <percorso>]

Il file è --file oppure MCP_HTTP_TOKENS_FILE. Il token in chiaro viene stampato una sola volta,
da create: nel file resta solo l'hash.`

export interface CliIO {
  out: (text: string) => void
  err: (text: string) => void
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('hex')
}

function defaultId(user: string, taken: ReadonlySet<string>): string {
  const slug =
    user
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'token'
  for (;;) {
    const id = `${slug}-${randomBytes(2).toString('hex')}`
    if (!taken.has(id)) return id
  }
}

function readEntries(file: string): TokenEntry[] {
  // Il CLI non conosce le wiki (WIKI_CONFIG): la loro esistenza la verifica il server all'avvio.
  return fs.existsSync(file) ? loadTokenFile(file) : []
}

interface CreateValues {
  user?: string
  wikis?: string
  groups?: string
  expires?: string
  id?: string
  note?: string
}

function create(file: string, values: CreateValues, io: CliIO): void {
  if (!values.user) throw new ConfigError('create: manca --user')
  if (!values.wikis)
    throw new ConfigError('create: manca --wikis (nomi separati da virgola, o "*")')
  const entries = readEntries(file)
  const groups = list(values.groups)
  const wikis = values.wikis.trim() === '*' ? '*' : list(values.wikis)
  const token = generateToken()
  const entry: Record<string, unknown> = {
    id: values.id ?? defaultId(values.user, new Set(entries.map((e) => e.id))),
    user: values.user,
    ...(groups.length > 0 ? { groups } : {}),
    wikis,
    tokenHash: `sha256:${createHash('sha256').update(token).digest('hex')}`,
    ...(values.expires ? { expiresAt: values.expires } : {}),
    ...(values.note ? { note: values.note } : {}),
  }
  // Stessa validazione del server, compresa l'unicità dell'id.
  const next = parseTokenFile([...entries, entry])
  writeTokenFile(file, next)
  io.err(
    `Token creato per "${values.user}" (id: ${entry.id as string}) in ${file}.\n` +
      "Copialo ora: non sarà più recuperabile (nel file c'è solo l'hash).",
  )
  io.out(token)
}

function listCmd(file: string, io: CliIO): void {
  const entries = readEntries(file)
  if (entries.length === 0) {
    io.out('(nessun token)')
    return
  }
  const now = Date.now()
  const rows = entries.map((e) => [
    e.id,
    e.user,
    (e.groups ?? []).join(',') || '-',
    e.wikis === '*' ? '*' : e.wikis.join(','),
    e.expiresAt ? `${e.expiresAt}${Date.parse(e.expiresAt) <= now ? ' (SCADUTO)' : ''}` : '-',
    e.note ?? '',
  ])
  const header = ['ID', 'UTENTE', 'GRUPPI', 'WIKI', 'SCADENZA', 'NOTE']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd()
  io.out([fmt(header), ...rows.map(fmt)].join('\n'))
}

function revoke(file: string, id: string | undefined, io: CliIO): void {
  if (!id) throw new ConfigError("revoke: manca l'id (vedi `list`)")
  const entries = readEntries(file)
  if (!entries.some((e) => e.id === id)) {
    throw new ConfigError(`revoke: nessun token con id "${id}" in ${file}`)
  }
  writeTokenFile(
    file,
    entries.filter((e) => e.id !== id),
  )
  io.err(
    `Token "${id}" revocato. Un server in esecuzione rilegge il file da solo entro pochi secondi.`,
  )
}

/** Esegue il CLI; restituisce il codice di uscita. Mai token negli errori. */
export function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIO): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        user: { type: 'string' },
        wikis: { type: 'string' },
        groups: { type: 'string' },
        expires: { type: 'string' },
        id: { type: 'string' },
        note: { type: 'string' },
        file: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    const [command, arg] = positionals
    if (values.help || !command) {
      io.out(USAGE)
      return command || values.help ? 0 : 1
    }
    const file = values.file ?? env.MCP_HTTP_TOKENS_FILE?.trim()
    if (!file) {
      throw new ConfigError('Indica il file dei token con --file o MCP_HTTP_TOKENS_FILE.')
    }
    switch (command) {
      case 'create':
        create(file, values, io)
        return 0
      case 'list':
        listCmd(file, io)
        return 0
      case 'revoke':
        revoke(file, arg, io)
        return 0
      default:
        throw new ConfigError(`Comando sconosciuto "${command}".\n${USAGE}`)
    }
  } catch (e) {
    io.err(`Errore: ${(e as Error).message}`)
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2), process.env, {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
  })
}
