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
| `proposals` | no | abilita `wikiProposePage` su HTTP per questa wiki: proposte di modifica come pull request GitHub. Vedi «Proposte di modifica da remoto». Senza, il tool non esiste per quella wiki |

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

Oltre allo stdio locale, il progetto espone un secondo entrypoint (`src/http.ts`) pensato per l'accesso da remoto, di sola lettura e limitato per default alle pagine della wiki: monta `wikiSearch`, `wikiReadPage`, `wikiListPages`, `wikiGraph` e `wikiStatus`. `wikiWritePage` e `wikiAppendLog` restano disponibili **solo** via stdio locale: chi accede da remoto non scrive mai sulla wiki servita. Può solo *proporre* modifiche, come pull request da rivedere, se la wiki lo abilita e il token ha il permesso (vedi «Proposte di modifica da remoto»).

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
| `groups` | no | gruppi dell'utente, usati dai permessi per pagina (vedi «Permessi per pagina»); il gruppo `admin` vede tutto |
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

**Limiti.** Il token resta un segreto Bearer portato da chi lo usa: chi lo copia, lo è. Non c'è OAuth né SSO (si potranno innestare in seguito producendo lo stesso `Principal`). Le sessioni MCP non sono legate al token che le ha aperte (ogni richiesta è ri-autenticata col token che porta, quindi una revoca vale subito, ma un id di sessione noto non è un segreto separato). L'identità decide **quali wiki** si possono raggiungere e, dentro una wiki, **quali pagine** si vedono (vedi «Permessi per pagina»); il permesso di *proporre* modifiche è un campo a parte del token (`propose`, vedi «Proposte di modifica da remoto»); l'audit di chi chiama cosa è in «Operatività». Nel file ci sono solo hash: un file trapelato non dà accesso, ma conviene tenerlo con permessi stretti comunque.

### Permessi per pagina

Dentro una wiki, ogni pagina può dichiarare chi la vede, nel frontmatter. I permessi valgono per le richieste HTTP con un token (i gruppi vengono dal token, vedi «Token per utente»).

```yaml
---
tipo: analisi
tags: [paghe]
fonti: []
aggiornato: 2026-10-30
stato: stabile
visibilita: riservata        # pubblica | interna | riservata   (opzionale)
gruppi: [hr, legal]          # opzionale, conta solo con riservata
---
```

Regole:

- **`visibilita` assente, `pubblica` o `interna`**: la pagina è visibile a ogni token che ha accesso alla wiki. Le wiki esistenti non cambiano comportamento. `interna` oggi ha lo stesso effetto di `pubblica`: è un'etichetta riservata a distinzioni future (ad esempio l'accesso anonimo) e non ha regole proprie.
- **`riservata`**: visibile solo a chi ha almeno un gruppo tra quelli in `gruppi`. Senza `gruppi` (o con la lista vuota) è visibile solo al gruppo speciale `admin`.
- **`admin`** vede sempre tutto, nella wiki a cui il token ha accesso.
- **`gruppi` su una pagina non riservata non ha effetto** (`wikiWritePage` lo segnala con `warnings`).
- **Fail-closed**: un valore di `visibilita` sconosciuto (un refuso come `riservta`) vale `riservata`, mai `pubblica`, ed è segnalato nel log (`page-visibility-invalid`, una volta per versione del file); `wikiReadPage` mostra `frontmatter.visibilitaNonValida` a chi può leggere la pagina. Un `gruppi` che non è una lista vale lista vuota. In scrittura (`wikiWritePage`) i valori non validi sono invece rifiutati con un errore descrittivo; `index.md`, `log.md`, `sources.md` e `overview.md` restano esenti dal resto del frontmatter, ma se dichiarano `visibilita`/`gruppi` quei due campi sono validati.
- **Il token legacy (`MCP_HTTP_TOKEN`) non ha gruppi**: non vede nessuna pagina `riservata`, nemmeno quelle con `gruppi`. Se serve un accesso completo con un token unico, crea un token per utente con il gruppo `admin` (`--groups admin`).
- **Stdio locale** (nessun token, nessun principal) vede e scrive tutto: fiducia piena.

Chi vede cosa, con tre pagine (`aperta` senza campo, `paghe` riservata a `hr`, `strategia` riservata senza `gruppi`):

| Pagina | token con `hr` | token con `it` | token senza gruppi (anche legacy) | token con `admin` | stdio locale |
| --- | --- | --- | --- | --- | --- |
| `aperta` (nessun campo, `pubblica` o `interna`) | sì | sì | sì | sì | sì |
| `paghe` (`riservata`, `gruppi: [hr]`) | sì | no | no | sì | sì |
| `strategia` (`riservata`, senza `gruppi`) | no | no | no | sì | sì |
| `refuso` (`visibilita: riservta`, `gruppi: [hr]`) | sì | no | no | sì | sì |

**Le pagine non permesse sono invisibili, non «negate».** Non compaiono in `wikiSearch`, `wikiListPages`, `wikiGraph` (nodi, archi, orfani) né in `wikiStatus` (`totalPages`, `byTipo`, `byStato`, `lastUpdated`), e `wikiReadPage` risponde esattamente come per una pagina inesistente (stesso messaggio, nessuna differenza osservabile). Per chi legge, una pagina riservata non esiste. Il filtro sta nel service (`src/wiki/service.ts`) e si applica a ogni richiesta in base al token; la cache delle pagine resta per pagina e non contiene risultati filtrati. Le funzioni pure che decidono (`canRead`, `canWrite`, `visibleTo`) sono in `src/wiki/access.ts`.

Il rifiuto compare solo nell'audit: la lettura diretta di una pagina **esistente** e non permessa produce un evento `denied` (`reason`: `visibility` o `visibility-invalid`), mentre una pagina davvero inesistente è un normale `error` «non trovata». Chi sbaglia slug e chi prova a leggere una riservata ricevono la stessa risposta, ma l'operatore li distingue. Ricerche, elenchi e grafo non producono `denied`: le pagine nascoste lì semplicemente non ci sono.

**Fughe indirette chiuse.** Il corpus su cui la ricerca calcola frequenze (IDF), punteggi e vocabolario per i refusi è formato dalle sole pagine visibili al token: i punteggi e le tolleranze sono quelli che si avrebbero in una wiki senza le pagine nascoste (verificato nei test confrontando con una wiki «gemella»). Lo stesso per snippet, conteggi e data `lastUpdated`. Nel grafo un link da una pagina visibile a una nascosta compare come link a una pagina inesistente (come in una wiki senza quella pagina): ometterlo soltanto distinguerebbe le nascoste dalle inesistenti. `wikiChecksum` (solo con `MCP_HTTP_EXPOSE_RAW=true`) non rivela esistenza né hash di una pagina nascosta di `wiki/`.

**Limiti noti, da conoscere.**

- **Il testo delle pagine visibili non è filtrato.** Se una pagina pubblica contiene `[[paghe]]` o cita per titolo una pagina riservata, chi la legge vede quel testo. Vale soprattutto per `index.md` e `overview.md`, che per natura elencano le pagine: chi scrive la wiki deve evitare di nominare lì le pagine riservate, oppure marcare anche quei file con `visibilita: riservata`. I file riservati di radice (`index.md`, `log.md`, `sources.md`, `overview.md`) non sono filtrati per default, ma se hanno `visibilita` nel frontmatter il filtro vale come per ogni pagina. Stesso discorso per `log.md` e `sources.md` (nomi di sorgenti e di pagine ingerite).
- **Le sorgenti `raw/` non hanno permessi per file.** `wikiListRaw`, `wikiReadRaw`, `wikiRawDiff` e `wikiChecksum` non applicano `visibilita`/`gruppi`: con `MCP_HTTP_EXPOSE_RAW=true` chi ha il token vede **tutto** `raw/` della wiki, anche se le pagine derivate sono riservate. Tieni `MCP_HTTP_EXPOSE_RAW` spento se le sorgenti contengono materiale riservato.
- Il metadato `source` di `wikiStatus` (commit e data di sync del checkout git) è della wiki intera, non per pagina.
- `GET /metrics` (token dedicato, per operatori) espone il numero totale di pagine della wiki, nascoste comprese.
- Le differenze di tempo tra «negata» e «inesistente» non sono mascherate.
- I permessi si basano sul frontmatter: chi può modificare i file della wiki (o scrivere su stdio) può cambiarli.

`GET /healthz` non richiede autenticazione e risponde `200` con `{"status":"ok"}`, senza contenuti della wiki né versioni: serve agli healthcheck (Docker, load balancer). Non passa dal server MCP e non è soggetto al rate limit.

Per l'esposizione su internet (non solo rete privata/VPN) metti un reverse proxy con TLS davanti (es. Caddy, nginx, Cloudflare Tunnel) — questo server non gestisce HTTPS direttamente.

Per far girare il server su una macchina Linux (systemd o Docker) e tenere la wiki aggiornata da git, con reverse proxy TLS e webhook opzionale, vedi [`deploy/README.md`](deploy/README.md).

Un agente **remoto** configura l'endpoint HTTP (`/mcp/<name>`) con il proprio token; un agente **locale** continua a usare solo la configurazione stdio (vedi sopra), che include già lettura e scrittura — non serve configurare entrambi i trasporti sulla stessa macchina.

## Proposte di modifica da remoto

Un client remoto non scrive mai sulla wiki servita. Se la wiki lo abilita, può però **proporre** la creazione o la modifica di una pagina con il tool `wikiProposePage` (solo su HTTP, mai in stdio, dove c'è già `wikiWritePage`): il server crea su GitHub un branch con il file e apre una **pull request**. Il tool non fa mai merge.

```text
agente remoto ──wikiProposePage──▶ server MCP ──API GitHub──▶ branch proposta/... + PR
                                                                   │  (revisione di una persona)
wiki servita ◀── sync (deploy/sync-wiki.sh) ◀── merge su main ◀───┘
```

1. L'agente chiama `wikiProposePage` con `path`, `content` completo (frontmatter incluso), e opzionalmente `rationale` e `title`. Ottiene `{ prUrl, prNumber, branch, action }`, con `action` `create` o `update`.
2. Il server verifica il permesso, il percorso, il contenuto e le regole sulla visibilità (sotto), poi apre la PR con il token GitHub del bot. Il commit è del bot; il messaggio riporta il trailer `Proposed-by: <utente> (<id del token>)` e lo stesso dato è nel corpo della PR.
3. Una persona rivede la PR su GitHub e la unisce (o la chiude). Il server non lo fa e non ne ha il permesso.
4. Il sync già descritto in [`deploy/README.md`](deploy/README.md) porta il merge nel checkout servito: solo a quel punto la pagina compare in `wikiReadPage`. Una proposta non è una modifica immediata, e il client deve dirlo all'utente (le `instructions` MCP lo spiegano).

### Configurazione

Campo `proposals` della voce della wiki in `WIKI_CONFIG` (validato con `.strict()`, errori all'avvio):

```json
[
  {
    "name": "hr",
    "wikiPath": "/var/lib/wiki-mcp/checkout/wiki",
    "proposals": {
      "repo": "organizzazione/wiki-privata",
      "baseBranch": "main",
      "pathPrefix": "wiki/",
      "tokenEnv": "GITHUB_TOKEN",
      "labels": ["proposta-mcp"]
    }
  }
]
```

| Campo | Default | Significato |
| --- | --- | --- |
| `repo` | (obbligatorio) | `proprietario/nome` del repository della wiki |
| `baseBranch` | `main` | branch verso cui si apre la PR (quello che il sync segue) |
| `pathPrefix` | `wiki/` | cartella delle pagine **dentro il repo** (`""` se stanno nella radice). Il path proposto, relativo alla wiki, ci si aggiunge davanti |
| `tokenEnv` | `GITHUB_TOKEN` | **nome** della variabile d'ambiente che contiene il token GitHub. Il token non va mai nel file di configurazione |
| `botName`, `botEmail` | `wiki-mcp-bot`, `wiki-mcp-bot@users.noreply.github.com` | identità di autore e committer dei commit |
| `labels` | `[]` | etichette applicate alla PR (se l'applicazione fallisce la PR resta aperta e il server lo scrive nel log) |
| `apiUrl` | `https://api.github.com` | per GitHub Enterprise (`https://ghe.example.com/api/v3`). `http` è ammesso solo verso localhost (finti server di prova) |
| `maxContentChars` | `100000` | dimensione massima del contenuto proposto |
| `maxRationaleChars` | `1000` | lunghezza massima della motivazione |
| `maxOpenPulls` | `20` | tetto alle PR di proposta (branch `proposta/...`) aperte contemporaneamente: oltre, nuove proposte sono rifiutate finché non vengono riviste (conteggio sulle prime 100 PR aperte del repo) |
| `rateLimitMax`, `rateLimitWindowSeconds` | `10`, `3600` | proposte per token (principal) nella finestra, in memoria, a finestra fissa |

Una wiki **senza** `proposals` non monta il tool. Se `proposals` c'è ma la variabile indicata da `tokenEnv` manca o è vuota, il processo non parte (errore chiaro all'avvio, senza stampare valori). Lo stdio ignora `proposals`.

### Permesso nel token: `propose`

Il permesso è esplicito, per wiki, e indipendente dalla lettura:

```bash
npm run token -- create --user alice --wikis hr,it --propose hr --groups hr
npm run token -- create --user bot --wikis '*' --propose '*'
npm run token -- list      # colonna PROPONE
```

Nel file dei token è il campo `propose` (`["hr"]` oppure `"*"`). Assente o vuoto significa nessun permesso, quindi i file dei token esistenti non cambiano comportamento. Le wiki in `propose` devono esistere e, se `wikis` è un elenco, farne parte. **Il token legacy (`MCP_HTTP_TOKEN`) non ha mai il permesso di proporre.**

### Token GitHub con permessi minimi

Un account o una GitHub App dedicata al bot, e un **fine-grained personal access token** (Settings → Developer settings → Personal access tokens → Fine-grained tokens):

- *Resource owner*: l'organizzazione (o l'utente) proprietaria del repo;
- *Repository access*: **Only select repositories**, solo il repo della wiki;
- *Repository permissions*: **Contents: Read and write** e **Pull requests: Read and write**; **Metadata: Read** è implicito. Nient'altro (niente Administration, Workflows, Actions, Issues);
- una scadenza breve (90 giorni o meno) e un promemoria per ruotarlo (vedi `deploy/README.md`).

Il token sta solo nell'ambiente del processo (`EnvironmentFile` con permessi `0600`), mai nel codice, nel file di configurazione, nell'audit o nei messaggi al client. Le etichette in `labels` vengono create da GitHub se non esistono, ma solo se il token può scrivere sulle issue/PR del repo: in caso contrario conviene crearle prima.

### Controlli, nell'ordine

1. **Permesso**: il principal esiste, ha accesso alla wiki e `propose` la include; altrimenti `denied` (`propose-not-allowed`). Poi il **rate limit** per token (`rate-limited`).
2. **Percorso**: relativo alla wiki, solo `.md`, niente `..`, percorsi assoluti, backslash o caratteri di controllo, niente segmenti nascosti (`.qualcosa`), niente `index.md`/`log.md`/`sources.md`/`overview.md` nella radice (gestiti dall'INGEST), non una cartella (`path-not-allowed`).
3. **Dimensione** del contenuto e della motivazione (`invalid-content`).
4. **Frontmatter**: lo stesso `validateFrontmatter` di `wikiWritePage` (`tipo`, `tags`, `fonti`, `aggiornato`, `stato`, `visibilita`, `gruppi`); gli errori sono mostrati al proponente (`invalid-content`).
5. **Pagina esistente** (nel checkout servito): serve `canWrite` per il principal, altrimenti `denied`. **Un non-admin non può cambiare `visibilita` o `gruppi` di una pagina esistente** (neppure abbassare una riservata di cui è membro): cambiare l'effetto di quei campi richiede `admin` (`visibility`).
6. **Pagina nuova riservata**: il proponente deve appartenere a uno dei `gruppi` indicati, oppure essere `admin` (`visibility`).
7. **Tetto alle PR aperte** (`open-prs-limit`) e confronto con il repo: se la pagina esiste già sul repo ma non nel checkout (sync in ritardo) la proposta è rifiutata (`not-synced`); un contenuto identico alla versione attuale non genera una PR vuota.

Per una modifica il file esistente viene aggiornato con lo SHA del blob letto dal repo (concorrenza ottimistica): se cambia nel frattempo GitHub rifiuta e il client riceve «la pagina è cambiata, riproponi». Se un passo fallisce dopo la creazione del branch, il server prova a cancellarlo (best effort, scritto nel log; se la cancellazione stessa fallisce il branch `proposta/...` va tolto a mano).

### Modello di minaccia e mitigazioni

| Rischio | Mitigazione |
| --- | --- |
| Un client scrive sulla wiki senza revisione | Il tool non scrive sul checkout né fa merge; la modifica arriva solo dopo il merge di una persona. Consigliati branch protection e CODEOWNERS sul repo (`deploy/README.md`) |
| Un token qualunque propone | Permesso `propose` esplicito per wiki, default vuoto; il legacy mai |
| Proporre su pagine riservate, o aprirne l'accesso | `canWrite` sulla pagina esistente; `visibilita`/`gruppi` di una pagina esistente solo per `admin`; nuove riservate solo con un proprio gruppo |
| Oracolo sull'esistenza delle pagine nascoste | Una pagina esistente ma non permessa riceve la stessa risposta di un percorso vietato («Percorso non consentito.»); solo l'audit sa il motivo. Vedi i residui sotto |
| Injection nei messaggi: a-capo che aprono trailer (`Co-authored-by:`), `@menzioni` che notificano, `#123`/`closes #5` che toccano issue, HTML o immagini esterne nel corpo | Nome utente, id, titolo e motivazione sono ridotti a una riga o citati riga per riga; `@` e `#` seguiti da cifra ricevono un carattere a larghezza zero; `< > & [ ]` sono escapati; lunghezze massime |
| Inondare il repo di PR | Rate limit per token, tetto alle PR aperte del bot, dimensione massima |
| Il token GitHub trapela dal server | Solo in ambiente (`tokenEnv`), mai in file, log, audit o risposte; permessi fine-grained sul solo repo; i messaggi di errore al client sono frasi fisse per tipo, senza il corpo delle risposte di GitHub |
| Contenuto malevolo nella pagina proposta | Resta una proposta: va letta in revisione come ogni altra modifica. La PR lo dice esplicitamente |

### Limiti noti, da conoscere

- **Oracolo residuo sull'esistenza.** Un proponente con `propose` può distinguere un percorso che non esiste (la proposta prosegue) da una pagina nascosta (negata con il messaggio generico), tentando proposte. Non si può chiudere senza aprire una PR di modifica su una pagina non permessa. Mitigazioni: il rate limit conta anche i rifiuti, ogni tentativo è nell'audit con `reason: visibility`, e il tetto alle PR aperte limita i tentativi andati a buon fine. Anche le differenze di tempo (lettura del file contro rifiuto immediato) non sono mascherate. Il caso «presente sul repo ma non ancora sul server» riceve lo stesso messaggio generico.
- Il rate limit è **in memoria** e per processo: riparte da zero al riavvio e non è condiviso tra più istanze.
- Il tetto alle PR aperte guarda le prime 100 PR aperte del repo (le più recenti): in un repo con molte PR di altri le proposte meno recenti potrebbero non essere contate. Non è una garanzia esatta: richieste concorrenti possono superarlo di poco.
- Il merge, la revisione e la protezione dei branch dipendono da GitHub e dalle persone: il server non può imporle. Senza branch protection chi ha accesso in scrittura al repo può unire senza revisione.
- Le PR si aprono dallo stesso repo (branch `proposta/...`), non da fork: il bot deve poter scrivere branch nel repo. Il token ha quindi accesso in scrittura ai contenuti: tenerlo come un segreto.
- Non c'è: modifica o chiusura di una proposta dal client, elenco delle proprie proposte, proposte su `raw/`, `wikiAppendLog` da remoto (un `log.md` in remoto non è proponibile), aggiornamento di una PR già aperta, merge automatico, notifiche. Ogni nuova modifica è una nuova PR.
- Il contenuto proposto è quello inviato dal client, per intero: non c'è un controllo di coerenza con la versione che il client ha letto, a parte l'SHA al momento della proposta.

## Operatività: log, audit e metriche

Il server HTTP scrive su **stdout** un oggetto JSON per riga (journald e Docker lo raccolgono così com'è). Tre cose escono dallo stesso canale, distinte dal campo `event`: i log applicativi (`startup`, `route`, `config-warning`, `token-file-error`, `request-error`, `reload`, ...), l'**audit** di ogni chiamata a un tool (`event: "audit"`) e gli **accessi rifiutati** (`event: "auth"`).

| Variabile | Default | Significato |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` o `silent`. Vale per i log applicativi; audit e `auth` non dipendono dal livello (sono sempre scritti) |
| `LOG_FORMAT` | `json` in HTTP, `text` in stdio | `json` (una riga = un oggetto) oppure `text` (`ts LEVEL evento chiave=valore ...`, leggibile in sviluppo) |
| `AUDIT_LOG_FILE` | non impostato | percorso di un file dove scrivere audit e `auth` (JSON, in append, `0600` alla creazione) invece che su stdout. Se non è scrivibile il processo non parte |
| `AUDIT_QUERY_MAX_CHARS` | `100` | caratteri massimi della query di `wikiSearch` registrati nell'audit |
| `MCP_METRICS_TOKEN` | non impostato | abilita `GET /metrics`, protetto da questo token Bearer. Senza, l'endpoint non esiste (`404`). Deve essere diverso da `MCP_HTTP_TOKEN` |

**stdio.** Lì stdout è il protocollo MCP: il logger scrive solo su **stderr** (formato `text`) e l'audit è **spento** a meno che si imposti `AUDIT_LOG_FILE`. Le chiamate locali sono registrate con `principal: {"id":"local","user":"local"}`. In stdio il file non si riapre con SIGHUP: per ruotarlo usa `copytruncate` (vedi sotto).

### Evento `audit`

Uno per ogni chiamata a un tool, di qualunque wiki. Lo produce un wrapper applicato alla registrazione dei tool (`src/server.ts`), non i tool stessi.

```json
{"ts":"2026-10-30T16:52:51.498Z","level":"info","event":"audit","requestId":"f3ef2b98-ee8f-41f4-bd58-4b6d4b669725","principal":{"id":"alice-1","user":"alice"},"wiki":"hr","tool":"wikiSearch","outcome":"ok","durationMs":0.79,"args":{"q":"uno","qLength":3,"topK":5},"resultSize":1}
```

| Campo | Significato |
| --- | --- |
| `ts`, `level`, `event` | istante ISO UTC, livello, tipo di evento |
| `requestId` | uuid della richiesta HTTP, lo stesso dell'evento `auth` se ce n'è uno; in stdio un uuid per chiamata |
| `principal` | `id` della credenziale e `user`; mai il token né il suo hash. `local` in stdio |
| `wiki`, `tool` | wiki servita dall'endpoint e nome MCP del tool |
| `outcome` | `ok`; `error` (il tool ha lanciato, o ha restituito `{error}` / `{success:false}`, come «pagina non trovata»); `denied` (negata: lettura diretta di una pagina esistente non permessa, vedi «Permessi per pagina»; la risposta al client resta identica a «non trovata») |
| `durationMs` | durata dell'esecuzione del tool |
| `args` | solo campi non sensibili e corti (slug, path, filtri, `topK`); la query di `wikiSearch` troncata (`q`) con la lunghezza originale (`qLength`); per le scritture solo `path` e `contentLength`/`entryLength`, **mai il contenuto** |
| `resultSize` | numero di elementi se il risultato è un elenco, altrimenti byte del risultato serializzato; assente in caso di errore |
| `error` | solo con `error`: messaggio breve su una riga, senza stack né percorsi assoluti |
| `reason` | solo con `denied`, da un vocabolario chiuso: `visibility` (pagina riservata, gruppo mancante; per le proposte anche tentativo di cambiare `visibilita`/`gruppi` senza essere admin), `visibility-invalid` (valore di `visibilita` sconosciuto, trattato come riservata) e, per `wikiProposePage`, `propose-not-allowed`, `path-not-allowed`, `invalid-content`, `rate-limited`, `open-prs-limit`, `not-synced`. Mai lo slug né i gruppi richiesti |
| `action`, `prUrl`, `prNumber`, `branch` | solo per `wikiProposePage`: azione (`create`/`update`) e identificativi della PR aperta (o, in caso di errore a metà, del branch). Mai contenuto, titolo o motivazione: negli `args` ci sono solo `path` e le lunghezze (`contentLength`, `rationaleLength`, `titleLength`) |

### Evento `auth`

Un evento per ogni accesso rifiutato (`/healthz` non genera eventi).

```json
{"ts":"2026-10-30T16:52:51.609Z","level":"info","event":"auth","requestId":"802a8d96-75ba-444c-88df-8375f4e9739c","ip":"127.0.0.1","reason":"wiki-not-allowed","status":404,"endpoint":"mcp","principal":{"id":"alice-1","user":"alice"},"requestedWiki":"it"}
```

`reason` è uno di: `missing-token`, `invalid-token` (sconosciuto o revocato), `expired-token`, `rate-limited` (con `retryAfterSeconds`), `wiki-not-allowed` e `wiki-unknown` (token valido, risposta `404`; `principal` e `requestedWiki` presenti). `endpoint` è `mcp` o `metrics`. Il client riceve sempre le stesse risposte di prima (`401`, `429`, `404` identico per wiki inesistente e non abilitata): il motivo esiste solo nel log. Il token presentato e i suoi hash non vengono mai registrati. `ip` è l'indirizzo del peer: dietro un reverse proxy è quello del proxy.

### Privacy

Una sanificazione unica (`src/log.ts`) vale per ogni riga: le chiavi `token`, `secret`, `password`, `authorization`, `cookie`, `hash` e i campi `content`/`body` sono redatti a qualunque profondità, le stringhe perdono `Bearer ...` e `sha256:...`, gli errori diventano un messaggio breve senza stack. Il JSON esce con i newline escapati e il formato `text` mette tra virgolette ogni valore non banale: un valore non può aprire una riga falsa. I test (`tests/http-observability.test.ts`) verificano con un token e un contenuto finti che non compaiano in nessuna riga.

Limite noto: una chiamata che la libreria MCP scarta per input non valido (argomenti che non rispettano lo schema) non arriva al tool, quindi non produce un evento `audit`; compare solo come richiesta HTTP nelle metriche. Gli errori interni della libreria `@mastra/mcp` escono su stderr, non strutturati.

### Interrogare il journal

```bash
# chi ha chiamato cosa, sulla wiki hr
journalctl -u wiki-mcp-http -o cat | jq -c 'select(.event=="audit" and .wiki=="hr") | {ts, user:.principal.user, tool, outcome, durationMs}'

# accessi rifiutati, per motivo e IP
journalctl -u wiki-mcp-http -o cat --since today | jq -r 'select(.event=="auth") | [.reason, .ip] | @tsv' | sort | uniq -c | sort -rn

# le chiamate lente (> 500 ms) o in errore
journalctl -u wiki-mcp-http -o cat | jq -c 'select(.event=="audit" and (.durationMs > 500 or .outcome != "ok"))'
```

Con Docker: `docker compose logs -f mcp | jq -c 'select(.event=="audit")'` (le righe di `docker compose logs` hanno un prefisso: `--no-log-prefix`).

### Metriche (`GET /metrics`)

Formato testo Prometheus, senza dipendenze, attivo solo con `MCP_METRICS_TOKEN`:

| Metrica | Etichette | Tipo |
| --- | --- | --- |
| `wiki_mcp_tool_calls_total` | `wiki`, `tool`, `outcome` | counter |
| `wiki_mcp_tool_duration_seconds` | `wiki`, `tool` | histogram (bucket fissi da 5 ms a 10 s) |
| `wiki_mcp_auth_failures_total` | `reason` | counter |
| `wiki_mcp_http_requests_total` | `status` | counter (esclusa `/healthz`) |
| `wiki_mcp_wiki_pages` | `wiki` | gauge, dalla cache del service |
| `wiki_mcp_proposals_total` | `wiki`, `outcome` (`created`, `denied`, `error`) | counter, solo per le wiki con `proposals` |

Le etichette vengono solo da insiemi chiusi (wiki configurate, tool registrati, motivi elencati sopra, codici di stato): mai utenti, slug o query. I contatori sono in memoria e ripartono da zero al riavvio, come vuole Prometheus.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: wiki-mcp
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/wiki-mcp-metrics.token
    static_configs:
      - targets: ['wiki.example.com']
```

```bash
curl -s -H "Authorization: Bearer $MCP_METRICS_TOKEN" http://127.0.0.1:3000/metrics
```

Un token errato o mancante dà `401` e conta nel rate limit per IP, come per l'endpoint MCP; un token MCP valido non apre `/metrics`.

### Rotazione del file di audit

Con `AUDIT_LOG_FILE` il file è aperto in append. Due modi coerenti, entrambi verificati dai test:

- **Riapertura su SIGHUP** (consigliata, HTTP): il processo apre di nuovo il percorso. `logrotate` sposta il file e manda il segnale; le righe già in coda finiscono nel file vecchio, le nuove vanno in quello nuovo. Il gestore di SIGHUP c'è sempre (senza file non fa nulla), quindi `systemctl reload` non uccide il servizio.
- **`copytruncate`**: sicuro perché il file è in append (dopo il troncamento si scrive dall'inizio). Può perdere le righe scritte tra la copia e il troncamento: serve per stdio, dove non c'è SIGHUP.

Esempio `/etc/logrotate.d/wiki-mcp`:

```
/var/log/wiki-mcp/audit.log {
    weekly
    rotate 12
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        systemctl kill -s HUP wiki-mcp-http.service
    endscript
}
```

Per Docker, senza file, la rotazione è quella del logging driver (`max-size`/`max-file`). Dettagli in [`deploy/README.md`](deploy/README.md).

## Licenza

MIT
