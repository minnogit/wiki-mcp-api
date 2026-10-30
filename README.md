# wiki-mcp-api

Server MCP (Model Context Protocol) che espone la wiki di dominio LLM Wiki agli agenti AI (Claude, OpenCode, ecc.) tramite stdio (locale, lettura+scrittura) o HTTP (remoto, sola lettura). Una sola istanza può servire più wiki, ciascuna con la propria cartella e il proprio endpoint (vedi «Più wiki»).

## Descrizione

Il server è domain-agnostic: il contenuto della wiki e il dominio che documenta vivono in una directory esterna indicata da `WIKI_PATH`/`RAW_PATH`, non in questo repo. Espone i seguenti tool MCP:

| Tool | Uso |
| --- | --- |
| `wikiSearch` | Ricerca full-text nella wiki (senza accenti, stemming italiano, frasi tra virgolette, refusi lievi) |
| `wikiReadPage` | Legge una pagina della wiki |
| `wikiListPages` | Elenca le pagine disponibili |
| `wikiWritePage` | Scrive una pagina (solo in `wiki/`) |
| `wikiAppendLog` | Aggiunge una riga di log all'ingest |
| `wikiListRaw` | Elenca i file sorgente grezzi (`raw/`) |
| `wikiReadRaw` | Legge un file sorgente grezzo (read-only) |
| `wikiRawDiff` | Mostra cosa è cambiato in un file sorgente rispetto alla versione già ingerita, via git (sola lettura) |
| `wikiChecksum` | Calcola il checksum di un file |
| `wikiGraph` | Restituisce il grafo dei collegamenti tra pagine |
| `wikiStatus` | Stato generale della wiki: conteggi, ultimo aggiornamento e, se la wiki è in un checkout git, freschezza della copia servita (`source`: SHA breve e data del commit HEAD, ora dell'ultimo fetch/pull) |

## Setup del progetto

```bash
npm install
cp .env.example .env
```

Configura in `.env`:

- `WIKI_PATH` — cartella contenente le pagine della wiki (scrivibile)
- `RAW_PATH` — cartella contenente i sorgenti grezzi da cui fare ingest (read-only)
- `WIKI_DOMAIN` — una riga che descrive il dominio documentato dalla wiki collegata, inclusa nelle `instructions` inviate al client MCP. Impostala per ogni istanza: senza, il client riceve solo una descrizione generica.
- `WIKI_TZ` — fuso IANA (es. `Europe/Rome`) con cui rendere le date derivate dalla data di modifica dei file. Opzionale.

Questa è la configurazione a wiki singola: il server serve una wiki di nome `default`. Per servirne più d'una vedi la sezione successiva.

## Più wiki

Una sola istanza del server può servire più wiki, ognuna con la propria cartella, il proprio dominio e il proprio fuso. Si elencano in un file JSON indicato da `WIKI_CONFIG`:

```json
[
  {
    "name": "hr",
    "wikiPath": "hr/wiki",
    "rawPath": "hr/raw",
    "domain": "Questa wiki documenta le procedure delle risorse umane.",
    "tz": "Europe/Rome"
  },
  { "name": "it", "wikiPath": "/srv/wikis/it/wiki" }
]
```

```bash
WIKI_CONFIG=/percorso/wikis.json
```

| Campo | Obbligatorio | Significato |
| --- | --- | --- |
| `name` | sì | identificativo, solo `[a-z0-9-]`, univoco; compare nell'URL (`/mcp/<name>`) |
| `wikiPath` | sì | cartella delle pagine |
| `rawPath` | no | cartella delle sorgenti. Se manca, i tool sulle sorgenti (`wikiListRaw`, `wikiReadRaw`, `wikiRawDiff`, `wikiChecksum`) non sono montati per quella wiki, in nessun trasporto, nemmeno con `MCP_HTTP_EXPOSE_RAW=true` |
| `domain` | no | riga di dominio per le `instructions` (come `WIKI_DOMAIN`) |
| `tz` | no | fuso IANA (come `WIKI_TZ`) |

I percorsi relativi sono risolti rispetto alla cartella del file di configurazione, non alla cartella da cui parte il processo. Il file è validato all'avvio: nome non valido, nome duplicato, campo sconosciuto o fuso inesistente fanno terminare il processo con un messaggio che indica la voce sbagliata.

Con `WIKI_CONFIG` impostata, `WIKI_PATH`, `RAW_PATH`, `WIKI_DOMAIN` e `WIKI_TZ` vengono ignorate (e non servono più nel `.env`): ogni wiki porta i propri valori. Senza `WIKI_CONFIG` il comportamento è quello di sempre, con una sola wiki `default`.

Ogni wiki ha il proprio service, la propria cache e il proprio server MCP: non c'è stato condiviso tra una wiki e l'altra, e un percorso non può uscire dalla cartella della propria wiki. I tool non hanno un parametro «wiki»: è l'endpoint (HTTP) o il processo (stdio) a scegliere la wiki.

- **stdio**: una wiki per processo, come prima. Con più wiki in `WIKI_CONFIG` si sceglie con `WIKI_NAME=<name>` (obbligatoria in quel caso, altrimenti il processo si ferma con un errore). Per usarne più d'una dallo stesso client si registrano più voci MCP con lo stesso comando e `WIKI_NAME` diversa.
- **HTTP**: una sola porta, `/mcp/<name>` serve la wiki `<name>` (vedi «Accesso remoto»).

## Build

```bash
npm run build
```

Genera l'eseguibile `dist/stdio.js`, che espone il server via stdio.

## Sviluppo

```bash
npm run dev
```

## Configurazione come server MCP

Il server comunica via **stdio**, quindi va lanciato come processo locale (`node dist/stdio.js`) dal client MCP. Prima di configurarlo esegui `npm run build` e prendi nota del percorso assoluto di `dist/stdio.js`.

### Claude Code

**Da CLI:**

```bash
claude mcp add --transport stdio wiki-mcp-api \
  -e WIKI_PATH=/percorso/assoluto/wiki \
  -e RAW_PATH=/percorso/assoluto/raw \
  -e WIKI_DOMAIN="Questa wiki documenta il dominio di <...>." \
  -- node /percorso/assoluto/wiki-mcp-api/dist/stdio.js
```

**Oppure via file di configurazione** (`~/.claude.json` per lo scope personale, o `.mcp.json` nella root del progetto per condividerlo via git):

```json
{
  "mcpServers": {
    "wiki-mcp-api": {
      "type": "stdio",
      "command": "node",
      "args": ["/percorso/assoluto/wiki-mcp-api/dist/stdio.js"],
      "env": {
        "WIKI_PATH": "/percorso/assoluto/wiki",
        "RAW_PATH": "/percorso/assoluto/raw",
        "WIKI_DOMAIN": "Questa wiki documenta il dominio di <...>."
      }
    }
  }
}
```

### OpenCode

Aggiungi il server in `opencode.json` (globale in `~/.config/opencode/opencode.json`, oppure nella root del progetto per una configurazione locale):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "wiki-mcp-api": {
      "type": "local",
      "command": ["node", "/percorso/assoluto/wiki-mcp-api/dist/stdio.js"],
      "enabled": true,
      "environment": {
        "WIKI_PATH": "/percorso/assoluto/wiki",
        "RAW_PATH": "/percorso/assoluto/raw",
        "WIKI_DOMAIN": "Questa wiki documenta il dominio di <...>."
      }
    }
  }
}
```

## Accesso remoto (sola lettura)

Oltre allo stdio locale, il progetto espone un secondo entrypoint (`src/http.ts`) pensato per l'accesso da remoto, di sola lettura e limitato per default alle pagine della wiki: monta `wikiSearch`, `wikiReadPage`, `wikiListPages`, `wikiGraph` e `wikiStatus`. `wikiWritePage` e `wikiAppendLog` restano disponibili **solo** via stdio locale: chi accede da remoto non può scrivere sulla wiki.

I tool sulle sorgenti (`wikiListRaw`, `wikiReadRaw`, `wikiRawDiff`, `wikiChecksum`) non sono montati in HTTP. Servono all'INGEST, che è un lavoro locale, e da remoto darebbero accesso a tutto ciò che sta in `RAW_PATH` e, con `wikiRawDiff`, alla sua storia git. `wikiChecksum` ne fa parte perché controlla anche `raw/`: senza i tool di lettura resterebbe un modo per sapere se un file esiste e qual è il suo hash. Se `RAW_PATH` contiene solo materiale che può leggere chiunque abbia il token, `MCP_HTTP_EXPOSE_RAW=true` li monta anche in HTTP.

Configura in `.env`:

- `MCP_HTTP_PORT` — porta di ascolto (default `3000`)
- `MCP_HTTP_HOST` — indirizzo di ascolto (default `127.0.0.1`, solo loopback). Per raggiungere il server da un'altra macchina o da fuori da un container imposta `0.0.0.0` (o l'IP di una specifica interfaccia), preferibilmente dietro un reverse proxy con TLS. Il log di avvio riporta l'indirizzo effettivo.
- `MCP_HTTP_RATE_LIMIT_MAX` / `MCP_HTTP_RATE_LIMIT_WINDOW_SECONDS` — rate limit per IP sulle richieste con token errato o mancante: superati `MCP_HTTP_RATE_LIMIT_MAX` fallimenti (default `10`) nella finestra (default `60` secondi) il server risponde `429` con `Retry-After`, anche se la richiesta successiva avesse il token giusto, finché la finestra non scade. Il contatore è in memoria e per IP del peer: dietro un reverse proxy tutti i client risultano lo stesso IP (`X-Forwarded-For` non viene considerato), quindi conviene limitare anche sul proxy.
- `MCP_HTTP_TOKENS_FILE` — file JSON dei token per utente (hash, gruppi, wiki abilitate), ricaricato da solo quando cambia: vedi «Token per utente» sotto.
- `MCP_HTTP_TOKEN` — token Bearer unico («legacy»), valido per tutte le wiki. Si può usare da solo o insieme al file dei token. Il processo si rifiuta di avviarsi se non c'è né questo né `MCP_HTTP_TOKENS_FILE`. Genera un valore casuale, es. `openssl rand -hex 32`.
- `MCP_HTTP_EXPOSE_RAW` — se vale esattamente `true` monta in HTTP anche i tool sulle sorgenti, per le wiki che hanno una cartella raw (default: non montati). All'avvio il server dice se sono esposti.

Avvio:

```bash
npm run dev:http     # sviluppo (tsx)
npm run build && npm run start:http   # produzione
```

Il server ascolta su `http://<host>:<porta>/mcp/<name>` (una wiki per endpoint, vedi «Più wiki») e richiede l'header `Authorization: Bearer <token>` su ogni richiesta (confronto a tempo costante). `/mcp` senza nome è un alias di retrocompatibilità, valido solo se è configurata **una sola** wiki (come senza `WIKI_CONFIG`, dove la wiki si chiama `default`); con più wiki risponde `404`. Un nome sconosciuto risponde `404`. Il controllo del token viene prima del routing: senza token valido si riceve sempre `401`, così non si può scoprire quali wiki esistono, né se ce n'è più d'una. I server MCP (uno per wiki) sono creati una volta all'avvio.

### Token per utente

Ogni persona (o servizio) ha il proprio token, con i gruppi a cui appartiene e le wiki che può leggere. Un token si revoca da solo, senza ruotare gli altri. Si gestiscono con il CLI, che scrive il file indicato da `MCP_HTTP_TOKENS_FILE`:

```bash
export MCP_HTTP_TOKENS_FILE=/percorso/tokens.json    # oppure --file <percorso> a ogni comando

# crea un token: viene stampato UNA sola volta su stdout, nel file finisce solo l'hash
npm run token -- create --user alice --wikis hr --groups hr,editor --expires 2027-01-01T00:00:00Z --note "portatile di Alice"
npm run token -- create --user ci-bot --wikis '*' --id ci-bot       # "*" = tutte le wiki

npm run token -- list              # id, utente, gruppi, wiki, scadenza (mai gli hash)
npm run token -- revoke alice-3f9a # per id (vedi list)
```

In produzione, dopo `npm run build`, lo stesso CLI è `node dist/cli/token.js <comando>`.

`create` genera `wmcp_` + 32 byte casuali in esadecimale, crea il file con permessi `0600` se manca e lo riscrive in modo atomico (file temporaneo + rename). Se `--id` non è dato, ne genera uno dal nome utente. Il token va consegnato a chi lo userà (`Authorization: Bearer wmcp_...`): se si perde, non si recupera, se ne crea un altro.

Il file è una lista JSON validata all'avvio (campi sconosciuti rifiutati):

| Campo | Obbligatorio | Significato |
| --- | --- | --- |
| `id` | sì | identificatore univoco della credenziale (`[A-Za-z0-9._-]`, `legacy` è riservato) |
| `user` | sì | a chi appartiene |
| `groups` | no | gruppi dell'utente (usati dai permessi per pagina, in arrivo) |
| `wikis` | sì | lista di nomi di wiki esistenti in `WIKI_CONFIG`, oppure `"*"` |
| `tokenHash` | sì | `sha256:<64 cifre esadecimali>` del token completo. Mai il token in chiaro |
| `expiresAt` | no | data ISO; dopo questa data il token è rifiutato (401) |
| `note` | no | testo libero |

Esempio: due utenti su due wiki. `wikis.json`:

```json
[
  { "name": "hr", "wikiPath": "hr/wiki" },
  { "name": "it", "wikiPath": "it/wiki" }
]
```

`tokens.json` (gli hash sono quelli di due token fittizi):

```json
[
  {
    "id": "alice-3f9a",
    "user": "alice",
    "groups": ["hr"],
    "wikis": ["hr"],
    "tokenHash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "expiresAt": "2027-01-01T00:00:00Z",
    "note": "portatile di Alice"
  },
  {
    "id": "bruno-7c21",
    "user": "bruno",
    "groups": ["it", "admin"],
    "wikis": "*",
    "tokenHash": "sha256:60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752"
  }
]
```

Con questa configurazione Alice raggiunge solo `/mcp/hr`; Bruno entrambe.

Comportamento:

- **Wiki non abilitata = wiki inesistente.** Un token valido su `/mcp/it` senza averla abilitata riceve lo stesso `404` (stesso corpo, stessi header) di un nome che non esiste: non si scopre quali wiki ci sono oltre alle proprie. Token sconosciuto, revocato o scaduto: `401`, e conta nel rate limit come prima.
- **Ricarica a caldo.** Il server controlla il file (inode, dimensione, mtime: `stat`, al massimo ogni 2 secondi) e lo rilegge quando cambia, quindi una revoca vale entro pochi secondi, senza riavvio. Se il file diventa invalido (JSON rotto, refuso, wiki inesistente) o sparisce, il server **tiene l'ultima versione valida** e scrive l'errore nel log: un refuso non chiude tutti, e non apre mai nulla. All'avvio, invece, un file invalido o mancante è un errore e il processo non parte.
- **Token legacy.** `MCP_HTTP_TOKEN` continua a funzionare, da solo o insieme al file: identità `legacy`, tutte le wiki, nessun gruppo. Se è l'unica credenziale configurata, all'avvio il server stampa un avviso che consiglia i token per utente. Per revocare un'utenza basta toglierla dal file; per il token legacy bisogna cambiarlo (e riavviare).
- **Identità nel codice.** Dentro i tool, `currentPrincipal()` (`src/auth.ts`) dà l'utente della richiesta; in stdio è `undefined` (locale, fiducia piena). Vedi CLAUDE.md.

**Limiti.** Il token resta un segreto Bearer portato da chi lo usa: chi lo copia, lo è. Non c'è OAuth né SSO (si potranno innestare in seguito producendo lo stesso `Principal`). Le sessioni MCP non sono legate al token che le ha aperte (ogni richiesta è ri-autenticata col token che porta, quindi una revoca vale subito, ma un id di sessione noto non è un segreto separato). Per ora l'identità decide solo **quali wiki** si possono raggiungere; la separazione per pagina, l'audit e la scrittura remota arrivano in seguito. Nel file ci sono solo hash: un file trapelato non dà accesso, ma conviene tenerlo con permessi stretti comunque.

`GET /healthz` non richiede autenticazione e risponde `200` con `{"status":"ok"}`, senza contenuti della wiki né versioni: serve agli healthcheck (Docker, load balancer). Non passa dal server MCP e non è soggetto al rate limit.

Per l'esposizione su internet (non solo rete privata/VPN) metti un reverse proxy con TLS davanti (es. Caddy, nginx, Cloudflare Tunnel) — questo server non gestisce HTTPS direttamente.

Per far girare il server su una macchina Linux (systemd o Docker) e tenere la wiki aggiornata da git, con reverse proxy TLS e webhook opzionale, vedi [`deploy/README.md`](deploy/README.md).

Un agente **remoto** configura l'endpoint HTTP (`/mcp/<name>`) con il proprio token; un agente **locale** continua a usare solo la configurazione stdio (vedi sopra), che include già lettura e scrittura — non serve configurare entrambi i trasporti sulla stessa macchina.

## Licenza

MIT
