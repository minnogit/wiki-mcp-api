# wiki-mcp-api

Server MCP (Model Context Protocol) che espone la wiki di dominio LLM Wiki agli agenti AI (Claude, OpenCode, ecc.) tramite stdio (locale, lettura+scrittura) o HTTP (remoto, sola lettura).

## Descrizione

Il progetto documenta il dominio del software PLService per la verbalizzazione del Codice della Strada italiano ed espone i seguenti tool MCP:

| Tool | Uso |
| --- | --- |
| `wiki_search` | Ricerca full-text nella wiki |
| `wiki_read_page` | Legge una pagina della wiki |
| `wiki_list_pages` | Elenca le pagine disponibili |
| `wiki_write_page` | Scrive una pagina (solo in `wiki/`) |
| `wiki_append_log` | Aggiunge una riga di log all'ingest |
| `wiki_list_raw` | Elenca i file sorgente grezzi (`raw/`) |
| `wiki_read_raw` | Legge un file sorgente grezzo (read-only) |
| `wiki_checksum` | Calcola il checksum di un file |
| `wiki_graph` | Restituisce il grafo dei collegamenti tra pagine |
| `wiki_status` | Stato generale della wiki |

## Setup del progetto

```bash
npm install
cp .env.example .env
```

Configura in `.env`:

- `WIKI_PATH` — cartella contenente le pagine della wiki (scrivibile)
- `RAW_PATH` — cartella contenente i sorgenti grezzi da cui fare ingest (read-only)

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
        "RAW_PATH": "/percorso/assoluto/raw"
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
        "RAW_PATH": "/percorso/assoluto/raw"
      }
    }
  }
}
```

## Accesso remoto (sola lettura)

Oltre allo stdio locale, il progetto espone un secondo entrypoint (`src/http.ts`) pensato per l'accesso da remoto: monta solo i tool di sola lettura (`wiki_search`, `wiki_read_page`, `wiki_list_pages`, `wiki_list_raw`, `wiki_read_raw`, `wiki_checksum`, `wiki_graph`, `wiki_status`). `wiki_write_page` e `wiki_append_log` restano disponibili **solo** via stdio locale: chi accede da remoto non può scrivere sulla wiki.

Configura in `.env`:

- `MCP_HTTP_PORT` — porta di ascolto (default `3000`)
- `MCP_HTTP_TOKEN` — token Bearer richiesto per autenticare le richieste; il processo si rifiuta di avviarsi se assente. Genera un valore casuale, es. `openssl rand -hex 32`.

Avvio:

```bash
npm run dev:http     # sviluppo (tsx)
npm run build && npm run start:http   # produzione
```

Il server ascolta su `http://<host>:<porta>/mcp` e richiede l'header `Authorization: Bearer <MCP_HTTP_TOKEN>` su ogni richiesta.

Per l'esposizione su internet (non solo rete privata/VPN) metti un reverse proxy con TLS davanti (es. Caddy, nginx, Cloudflare Tunnel) — questo server non gestisce HTTPS direttamente.

Un agente **remoto** configura l'endpoint HTTP con il token; un agente **locale** continua a usare solo la configurazione stdio (vedi sopra), che include già lettura e scrittura — non serve configurare entrambi i trasporti sulla stessa macchina.

## Licenza

MIT
