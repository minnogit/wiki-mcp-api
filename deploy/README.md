# Deploy su un server remoto

Questa cartella contiene quanto serve per far girare il server MCP HTTP (`src/http.ts`, sola lettura) su una macchina Linux e tenere la wiki aggiornata partendo da git. Il codice del server non cambia: qui ci sono solo script, unit systemd, un Dockerfile e un receiver di webhook opzionale.

## Architettura

```
 locale                         GitHub (repo privato)               server remoto
 ------                         ---------------------               -------------
 commit + push  ───────────►    origin/main  ◄── git fetch ───────  wiki-sync.timer (ogni ~90 s)
                                     │                                    │
                                     └── webhook push ─► wiki-webhook ────┤  (acceleratore, opzionale)
                                                                          ▼
                                                          sync-wiki.sh: fetch + reset --hard
                                                                          ▼
                                                    checkout di sola lettura (wiki/, opz. raw/)
                                                                          ▼
                                                     wiki-mcp-http  ◄── reverse proxy TLS ◄── client MCP
```

- **Git è l'unico canale.** La wiki si scrive in locale (con il server MCP stdio, che ha i tool di scrittura), si fa commit e push. Il server remoto non riceve mai contenuti in altro modo e non ha tool di scrittura.
- **Il checkout è di sola lettura.** `sync-wiki.sh` fa `git fetch` + `git reset --hard origin/main`, mai un merge: eventuali modifiche locali sul server vengono scartate e il checkout converge sempre al remoto, anche dopo un force-push. Il checkout è scritto dall'utente `wikisync`; il server gira come `wikimcp` e lo vede con `ReadOnlyPaths`.
- **Il timer è la base, il webhook un acceleratore.** Il timer sincronizza ogni 90 secondi circa (con jitter) e basta da solo. Il webhook, se lo attivi, riduce il ritardo a pochi secondi; se salta, il timer rimedia.
- **Flusso:** committo e pusho da locale, entro un paio di minuti (pochi secondi col webhook) il remoto ha le stesse pagine.
- Per default il checkout è sparse e contiene solo `wiki/`. `raw/` si porta solo se serve (`WIKI_INCLUDE_RAW=true`), tipicamente insieme a `MCP_HTTP_EXPOSE_RAW=true`: vedi la sezione «Accesso remoto» del README principale.

Contenuto della cartella:

| File | A cosa serve |
| --- | --- |
| `sync-wiki.sh` | sincronizza il checkout con `origin/main` (primo clone incluso) |
| `sync-loop.sh` | ciclo di sincronizzazione per il sidecar Docker |
| `systemd/wiki-mcp-http.service` | il server HTTP |
| `systemd/wiki-sync.service`, `wiki-sync.timer` | sincronizzazione periodica |
| `systemd/wiki-webhook.service` | receiver del webhook (opzionale) |
| `webhook/webhook-sync.mjs` | receiver del webhook GitHub, senza dipendenze npm |
| `docker-compose.example.yml` | alternativa Docker (con `Dockerfile` nella radice) |

## Installazione con systemd

Percorsi usati dalle unit: applicazione in `/opt/wiki-mcp-api`, configurazione in `/etc/wiki-mcp/`, checkout in `/var/lib/wiki-mcp/checkout` (creato da systemd). Se li cambi, aggiorna le unit.

### 1. Utenti di servizio

Due utenti senza shell né home: uno scrive il checkout, l'altro lo legge.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin wikisync
sudo useradd --system --no-create-home --shell /usr/sbin/nologin wikimcp
sudo mkdir -p /etc/wiki-mcp
```

### 2. Il codice

Serve Node 24 e git.

```bash
sudo git clone https://github.com/minnogit/wiki-mcp-api.git /opt/wiki-mcp-api
cd /opt/wiki-mcp-api
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev
```

### 3. Deploy key di sola lettura per il repo privato

```bash
sudo ssh-keygen -t ed25519 -N '' -C 'wiki-mcp deploy key' -f /etc/wiki-mcp/deploy_key
sudo chown wikisync:wikisync /etc/wiki-mcp/deploy_key
sudo chmod 600 /etc/wiki-mcp/deploy_key
sudo cat /etc/wiki-mcp/deploy_key.pub
```

Su GitHub, nel repo della wiki: Settings → Deploy keys → Add deploy key, incolla la chiave pubblica e **lascia deselezionato «Allow write access»**. Il server non deve poter scrivere sul repo.

### 4. Configurazione

`/etc/wiki-mcp/sync.env` (sincronizzazione, letto anche dal webhook):

```bash
WIKI_REPO_URL=git@github.com:ORGANIZZAZIONE/wiki-privata.git
WIKI_BRANCH=main
WIKI_CHECKOUT=/var/lib/wiki-mcp/checkout
WIKI_SSH_KEY=/etc/wiki-mcp/deploy_key
# WIKI_INCLUDE_RAW=true
```

`/etc/wiki-mcp/http.env` (server HTTP):

```bash
MCP_HTTP_TOKEN=<openssl rand -hex 32>
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3000
WIKI_PATH=/var/lib/wiki-mcp/checkout/wiki
RAW_PATH=/var/lib/wiki-mcp/checkout/raw
WIKI_DOMAIN=Questa wiki documenta il dominio di ...
WIKI_TZ=Europe/Rome
# MCP_HTTP_EXPOSE_RAW=true
```

```bash
sudo chown root:wikimcp /etc/wiki-mcp/http.env && sudo chmod 640 /etc/wiki-mcp/http.env
sudo chown root:wikisync /etc/wiki-mcp/sync.env && sudo chmod 640 /etc/wiki-mcp/sync.env
```

Il token non va committato né messo nelle unit: sta solo in `http.env`.

### 5. Unit e avvio

```bash
sudo cp /opt/wiki-mcp-api/deploy/systemd/wiki-*.service /opt/wiki-mcp-api/deploy/systemd/wiki-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload

# primo clone, a mano, per vedere subito eventuali errori di chiave o di URL
sudo systemctl start wiki-sync.service
journalctl -u wiki-sync.service -n 20 --no-pager

sudo systemctl enable --now wiki-sync.timer wiki-mcp-http.service
```

Se il repo della wiki è stato clonato per la prima volta con un URL SSH, `StrictHostKeyChecking=accept-new` registra la chiave di GitHub al primo accesso, in `/var/lib/wiki-mcp/.ssh/known_hosts`.

### 6. Reverse proxy con TLS (esempio Caddy)

Il server ascolta solo su `127.0.0.1`: non gestisce HTTPS e non va esposto direttamente. Caddy ottiene e rinnova il certificato da solo.

```caddyfile
wiki.example.com {
    # il webhook (passo 7) ha il proprio percorso; il resto va al server MCP
    handle /webhook {
        reverse_proxy 127.0.0.1:9000
    }
    handle {
        reverse_proxy 127.0.0.1:3000 {
            # risposte in streaming: niente buffering
            flush_interval -1
        }
    }
}
```

Il DNS di `wiki.example.com` deve puntare al server e le porte 80/443 devono essere raggiungibili. Con nginx o un tunnel Cloudflare vale lo stesso schema: TLS davanti, `127.0.0.1:3000` dietro.

### 7. Webhook GitHub (opzionale)

`/etc/wiki-mcp/webhook.env`:

```bash
WEBHOOK_SECRET=<openssl rand -hex 32>
WEBHOOK_BRANCH=main
WEBHOOK_PORT=9000
```

```bash
sudo chown root:wikisync /etc/wiki-mcp/webhook.env && sudo chmod 640 /etc/wiki-mcp/webhook.env
sudo systemctl enable --now wiki-webhook.service
```

Su GitHub, nel repo della wiki: Settings → Webhooks → Add webhook:

- Payload URL: `https://wiki.example.com/webhook`
- Content type: `application/json`
- Secret: lo stesso `WEBHOOK_SECRET`
- Events: solo «Just the push event»

Il receiver verifica la firma HMAC SHA-256 (`X-Hub-Signature-256`, confronto a tempo costante), ignora i push su branch diversi da `WEBHOOK_BRANCH` ed esegue `sync-wiki.sh` con `execFile`, senza shell. Se una sincronizzazione è in corso, ne accoda al massimo una successiva: più push ravvicinati si fondono. Ascolta solo su `127.0.0.1`.

## Installazione con Docker

`docker-compose.example.yml` avvia due container dalla stessa `Dockerfile`: `sync` (target `sync`, con git e `sync-loop.sh`) scrive il checkout in un volume, `mcp` lo monta in sola lettura ed espone il server su `127.0.0.1:3000`. Dentro il container il server ascolta su `0.0.0.0` (`MCP_HTTP_HOST`), perché altrimenti la porta pubblicata non sarebbe raggiungibile; la pubblicazione sul solo loopback dell'host mantiene la stessa esposizione dell'installazione systemd.

```bash
cd deploy
cp docker-compose.example.yml docker-compose.yml
cp ../.env.example .env.mcp          # lascia solo MCP_HTTP_TOKEN e le variabili che ti servono
# metti la deploy key in deploy/deploy_key (chmod 600, leggibile dall'uid 1000)
docker compose up -d --build
docker compose ps                    # lo stato di salute arriva da /healthz
```

L'immagine contiene solo il codice compilato e le dipendenze di produzione, gira come utente non root e non contiene la wiki. Il reverse proxy TLS si configura come sopra.

## Più wiki sullo stesso server

Una sola istanza serve più wiki (`WIKI_CONFIG`, vedi README principale). Dal lato deploy cambia poco: ogni wiki è un checkout a sé, e `sync-wiki.sh` ne gestisce uno per volta, quindi si lancia una volta per wiki con variabili diverse. Gli script non cambiano.

1. Un `sync-<nome>.env` per wiki, con `WIKI_CHECKOUT` e `WIKI_REPO_URL` (e se serve `WIKI_SSH_KEY`, `WIKI_BRANCH`, `WIKI_INCLUDE_RAW`) diversi, ad esempio `WIKI_CHECKOUT=/var/lib/wiki-mcp/hr`. Il lock di default è `<checkout>.lock`, quindi sincronizzazioni di wiki diverse non si bloccano a vicenda.
2. Con systemd, una coppia di unit per wiki: copia `wiki-sync.service` e `wiki-sync.timer` in `wiki-sync-<nome>.service` / `.timer`, cambia `EnvironmentFile=` con `sync-<nome>.env` e `Unit=`/`Description=` di conseguenza, poi `systemctl enable --now wiki-sync-<nome>.timer`. Le unit condividono `StateDirectory=wiki-mcp`, quindi i checkout stanno tutti sotto `/var/lib/wiki-mcp` e restano leggibili dal server (`ReadOnlyPaths`). Il webhook (passo 7) lancia un solo `sync-wiki.sh`: con più wiki resta valido per quella del suo `sync.env`, per le altre basta il timer (o un secondo receiver con la sua porta e il suo `.env`).
3. Con Docker, un servizio `sync` per wiki nel compose, ciascuno con `WIKI_CHECKOUT` e `WIKI_REPO_URL` propri e un proprio volume (o la stessa radice con sottocartelle), tutti montati in sola lettura nel servizio `mcp`.
4. Un `wikis.json` accanto a `http.env` (es. `/etc/wiki-mcp/wikis.json`) con i percorsi dei checkout, e `WIKI_CONFIG=/etc/wiki-mcp/wikis.json` in `http.env` al posto di `WIKI_PATH`/`RAW_PATH`/`WIKI_DOMAIN`/`WIKI_TZ`:

```json
[
  { "name": "hr", "wikiPath": "/var/lib/wiki-mcp/hr/wiki", "domain": "...", "tz": "Europe/Rome" },
  { "name": "it", "wikiPath": "/var/lib/wiki-mcp/it/wiki" }
]
```

Il reverse proxy non cambia (stessa porta). I client usano `https://wiki.example.com/mcp/<name>`. Il token è uno solo per tutte le wiki: non mettere sullo stesso server wiki con riservatezza diversa finché non esistono token per utente o gruppo. Il Dockerfile resta com'è: `WIKI_PATH`/`RAW_PATH` impostate nell'immagine vengono semplicemente ignorate quando `WIKI_CONFIG` è presente.

## Collegare un client MCP remoto

Il server parla MCP su HTTP e richiede `Authorization: Bearer <MCP_HTTP_TOKEN>` su ogni richiesta, all'URL `https://wiki.example.com/mcp/<name>`. Con una sola wiki configurata (anche senza `WIKI_CONFIG`, dove si chiama `default`) vale anche l'alias `https://wiki.example.com/mcp`; con più wiki l'alias risponde 404. Gli esempi di configurazione del client qui sotto usano l'alias.

Claude Code:

```bash
claude mcp add --transport http wiki-remota https://wiki.example.com/mcp \
  --header "Authorization: Bearer $MCP_HTTP_TOKEN"
```

Oppure in `.mcp.json`:

```json
{
  "mcpServers": {
    "wiki-remota": {
      "type": "http",
      "url": "https://wiki.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_HTTP_TOKEN}" }
    }
  }
}
```

Tieni il token in una variabile d'ambiente, non nel file. Da remoto sono disponibili solo i tool di lettura delle pagine (più quelli sulle sorgenti se hai impostato `MCP_HTTP_EXPOSE_RAW=true`).

## Verificare lo stato

```bash
# server vivo (non richiede token)
curl -fsS http://127.0.0.1:3000/healthz            # {"status":"ok"}
curl -fsS https://wiki.example.com/healthz         # attraverso il proxy

# autenticazione: 401 senza token, non-401 con token
curl -s -o /dev/null -w '%{http_code}\n' https://wiki.example.com/mcp/<name>
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $MCP_HTTP_TOKEN" https://wiki.example.com/mcp/<name>

# sincronizzazione
systemctl list-timers wiki-sync.timer
journalctl -u wiki-sync.service -n 20 --no-pager
git -C /var/lib/wiki-mcp/checkout log -1 --format='%h %cd %s'

# servizi
systemctl status wiki-mcp-http.service wiki-webhook.service
journalctl -u wiki-mcp-http.service -f
```

Per confrontare il checkout con il remoto: `git -C /var/lib/wiki-mcp/checkout rev-parse --short HEAD` deve coincidere con `git ls-remote <url> refs/heads/main`.

## Risoluzione problemi

| Sintomo | Causa probabile e rimedio |
| --- | --- |
| `wiki-sync.service` fallisce con `Permission denied (publickey)` | la deploy key non è stata aggiunta al repo, o `WIKI_SSH_KEY` non è leggibile da `wikisync` (`ls -l /etc/wiki-mcp/deploy_key`). |
| `il checkout ... non esiste e WIKI_REPO_URL non è impostato` | manca `WIKI_REPO_URL` in `sync.env`. |
| `git fetch fallito ... branch inesistente` | `WIKI_BRANCH` non esiste nel remoto. |
| `lock ... non ottenuto` | un'altra sincronizzazione è bloccata (rete lenta?). Cerca `git` in esecuzione con `ps`; il lock si libera da solo quando il processo termina. |
| `wiki-mcp-http` esce subito con `MCP_HTTP_TOKEN non impostato` | `http.env` mancante o non leggibile da `wikimcp`. |
| Il server parte ma le pagine non ci sono | `WIKI_PATH` non punta a `<checkout>/wiki`, oppure la prima sincronizzazione non è mai riuscita. |
| `404` con il token giusto | con più wiki `/mcp` senza nome non esiste, e un nome non presente in `wikis.json` è sconosciuto: usa `/mcp/<name>`. |
| `wiki-mcp-http` esce subito con `WIKI_CONFIG non valido` | l'errore elenca la voce sbagliata (nome non valido o duplicato, campo sconosciuto, fuso inesistente). |
| `401` anche con il token | token diverso da quello in `http.env`, o il proxy non inoltra l'header `Authorization`. |
| Una modifica fatta a mano nel checkout sparisce | è voluto: ogni sincronizzazione fa `reset --hard`. Le modifiche si fanno in locale e si pushano. |
| Il push c'è ma il server non si aggiorna | guarda `journalctl -u wiki-sync.service`; per il webhook, in GitHub → Webhooks → Recent Deliveries (401 = segreto diverso, 202 `ignored` = branch diverso) e `journalctl -u wiki-webhook.service`. |
| Il server non si raggiunge dall'esterno | è voluto che ascolti solo su loopback: serve il proxy. Controlla `systemctl status caddy` e le porte 80/443. |

Per escludere il timer durante una manutenzione: `sudo systemctl stop wiki-sync.timer`.
