#!/usr/bin/env bash
#
# Sincronizza un checkout di SOLA LETTURA del repo della wiki con origin/main.
#
# Il checkout è una copia da cui il server MCP legge: nessuno ci scrive a mano.
# Per questo la sincronizzazione è `git fetch` + `git reset --hard`, mai un merge:
# qualunque modifica locale (file sporcati, commit locali) viene scartata e il
# checkout converge sempre allo stato del remoto, anche dopo un force-push.
#
# Variabili d'ambiente (tutte opzionali tranne dove indicato):
#   WIKI_CHECKOUT           percorso del checkout            (default: /srv/wiki/checkout)
#   WIKI_REPO_URL           URL del repo della wiki; serve al primo clone e, se
#                           diverso, aggiorna l'URL del remote (obbligatorio se il
#                           checkout non esiste ancora)
#   WIKI_REMOTE             nome del remote                  (default: origin)
#   WIKI_BRANCH             branch da seguire                (default: main)
#   WIKI_INCLUDE_RAW        "true" per portare anche raw/    (default: false, solo wiki/)
#   WIKI_SPARSE             "false" per un checkout completo (default: true)
#   WIKI_SSH_KEY            chiave SSH (deploy key) da usare per git
#   WIKI_SYNC_LOCK          file di lock                     (default: <checkout>.lock)
#   WIKI_SYNC_LOCK_TIMEOUT  secondi di attesa del lock       (default: 120)
#
# Exit code: 0 = sincronizzato (o già aggiornato), diverso da 0 = errore.

set -euo pipefail

CHECKOUT="${WIKI_CHECKOUT:-/srv/wiki/checkout}"
REPO_URL="${WIKI_REPO_URL:-}"
REMOTE="${WIKI_REMOTE:-origin}"
BRANCH="${WIKI_BRANCH:-main}"
INCLUDE_RAW="${WIKI_INCLUDE_RAW:-false}"
SPARSE="${WIKI_SPARSE:-true}"
LOCK_FILE="${WIKI_SYNC_LOCK:-${CHECKOUT%/}.lock}"
LOCK_TIMEOUT="${WIKI_SYNC_LOCK_TIMEOUT:-120}"

log() { printf '%s sync-wiki: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERRORE: $*" >&2; exit 1; }

command -v git >/dev/null || die "git non trovato nel PATH"
command -v flock >/dev/null || die "flock non trovato nel PATH (pacchetto util-linux)"

# Mai prompt interattivi: un timer non ha un terminale a cui rispondere.
export GIT_TERMINAL_PROMPT=0
if [[ -n "${WIKI_SSH_KEY:-}" ]]; then
  [[ -r "$WIKI_SSH_KEY" ]] || die "WIKI_SSH_KEY non leggibile: $WIKI_SSH_KEY"
  export GIT_SSH_COMMAND="ssh -i ${WIKI_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
fi

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_TIMEOUT" 9; then
  die "lock $LOCK_FILE non ottenuto in ${LOCK_TIMEOUT}s: un'altra sincronizzazione è bloccata?"
fi

git_c() { git -C "$CHECKOUT" "$@"; }

sparse_paths() {
  if [[ "$INCLUDE_RAW" == "true" ]]; then
    echo "wiki raw"
  else
    echo "wiki"
  fi
}

if [[ ! -d "$CHECKOUT/.git" ]]; then
  [[ -n "$REPO_URL" ]] || die "il checkout $CHECKOUT non esiste e WIKI_REPO_URL non è impostato"
  if [[ -e "$CHECKOUT" ]] && [[ -n "$(ls -A "$CHECKOUT" 2>/dev/null)" ]]; then
    die "$CHECKOUT esiste, non è un repo git ed è non vuoto: non lo tocco"
  fi
  log "primo clone di $REPO_URL (branch $BRANCH) in $CHECKOUT"
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone --quiet --no-checkout --origin "$REMOTE" --branch "$BRANCH" "$REPO_URL" "$CHECKOUT"
  BEFORE="(nessuno)"
else
  BEFORE="$(git_c rev-parse --short HEAD 2>/dev/null || echo '(nessuno)')"
fi

if [[ -n "$REPO_URL" ]]; then
  CURRENT_URL="$(git_c remote get-url "$REMOTE" 2>/dev/null || true)"
  if [[ "$CURRENT_URL" != "$REPO_URL" ]]; then
    log "aggiorno l'URL del remote $REMOTE"
    if [[ -n "$CURRENT_URL" ]]; then
      git_c remote set-url "$REMOTE" "$REPO_URL"
    else
      git_c remote add "$REMOTE" "$REPO_URL"
    fi
  fi
fi

if [[ "$SPARSE" == "true" ]]; then
  # shellcheck disable=SC2046
  git_c sparse-checkout set --cone $(sparse_paths)
else
  git_c sparse-checkout disable 2>/dev/null || true
fi

log "fetch di $REMOTE/$BRANCH"
git_c fetch --quiet --prune "$REMOTE" "+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}" \
  || die "git fetch fallito (rete, credenziali o branch inesistente)"

TARGET="refs/remotes/${REMOTE}/${BRANCH}"
git_c rev-parse --verify --quiet "${TARGET}^{commit}" >/dev/null \
  || die "branch $REMOTE/$BRANCH non trovato"

# -f scarta eventuali modifiche locali; poi reset --hard e clean eliminano anche
# file tracciati sporcati e file non tracciati rimasti nella working tree.
git_c checkout --quiet -f -B "$BRANCH" "$TARGET"
git_c reset --quiet --hard "$TARGET"
git_c clean --quiet -fd

AFTER="$(git_c rev-parse --short HEAD)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  log "già aggiornato a $AFTER"
else
  log "aggiornato: $BEFORE -> $AFTER"
fi
