import * as fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Freschezza della wiki servita: da quale commit del checkout git proviene e quando è stato
// fatto l'ultimo sync. Volutamente senza percorsi assoluti né URL del remote: il tool
// wikiStatus è montato anche via HTTP.
export interface WikiSource {
  /** SHA breve del commit HEAD del repo che contiene la wiki */
  commit: string
  /** data del commit HEAD, ISO 8601 (committer date) */
  commitDate: string
  /**
   * Ora dell'ultimo sync, ISO 8601: mtime di `FETCH_HEAD`, che git riscrive a ogni
   * `git fetch`/`git pull` anche quando non c'è nulla di nuovo. `null` se il repo non ha mai
   * fatto fetch (clone locale, `git init`) oppure se il file è stato rimosso: non è un errore.
   * Non è un dato di sicurezza: un fetch manuale o un `git gc` non lo falsano, ma un
   * checkout aggiornato senza fetch (copia/rsync del `.git`) non lo muove.
   */
  syncedAt: string | null
}

const GIT_TIMEOUT_MS = 10_000

function runGit(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', ['-C', cwd, ...args], {
    maxBuffer: 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
  }).then((r) => r.stdout)
}

/**
 * Legge SHA/data del commit HEAD e ora dell'ultimo sync del repo git che contiene `dir`
 * (che può esserne anche solo una sottocartella). Non lancia mai: se git manca, `dir` non è
 * in un repo, il repo non ha commit o qualunque altra cosa va storta, restituisce `null`.
 */
export async function getWikiSource(dir: string): Promise<WikiSource | null> {
  try {
    const out = await runGit(dir, ['log', '-1', '--format=%h%n%cI', 'HEAD'])
    const [commit, commitDate] = out.trim().split('\n')
    if (!commit || !commitDate) return null

    let syncedAt: string | null = null
    try {
      const fetchHead = (
        await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])
      ).trim()
      syncedAt = (await fsp.stat(fetchHead)).mtime.toISOString()
    } catch {
      // FETCH_HEAD assente o git troppo vecchio per --path-format: sync sconosciuto
    }
    return { commit, commitDate, syncedAt }
  } catch {
    return null
  }
}
