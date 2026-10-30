#!/usr/bin/env bash
#
# Sidecar Docker: esegue sync-wiki.sh a intervalli regolari (con un po' di jitter).
# Un errore di sincronizzazione non ferma il ciclo: al giro dopo si riprova.
#
#   WIKI_SYNC_INTERVAL   secondi tra una sincronizzazione e la successiva (default: 90)
#   WIKI_SYNC_JITTER     secondi massimi di jitter casuale aggiunti       (default: 20)
# Le altre variabili WIKI_* sono quelle di sync-wiki.sh.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${WIKI_SYNC_INTERVAL:-90}"
JITTER="${WIKI_SYNC_JITTER:-20}"

trap 'exit 0' TERM INT

while true; do
  "$DIR/sync-wiki.sh" || echo "sync-loop: sincronizzazione fallita, riprovo al prossimo giro" >&2
  # sleep in background + wait: il trap interrompe subito l'attesa su SIGTERM.
  sleep $((INTERVAL + RANDOM % (JITTER + 1))) &
  wait $!
done
