# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generic MCP (Model Context Protocol) server, built on `@mastra/mcp`, that exposes a markdown-file-based wiki to AI agents. It is domain-agnostic: the wiki content itself (pages, frontmatter conventions, ingest workflow) lives in an external directory pointed to by env vars, not in this repo. This repo is only the server/tool implementation.

Two transports are exposed from the same tool set, defined in `src/server.ts`:
- **stdio** (`src/stdio.ts`) — local process, full read+write tool set. This is what MCP clients (Claude Code, OpenCode) spawn directly.
- **HTTP** (`src/http.ts`) — remote, **read-only**, Bearer-token authenticated. Refuses to start without `MCP_HTTP_TOKEN` set.

## Commands

```bash
npm install
cp .env.example .env        # set WIKI_PATH / RAW_PATH before running

npm run dev                  # run src/stdio.ts directly via tsx (no build step)
npm run dev:http             # run src/http.ts directly via tsx
npm run build                # bundle stdio.ts & http.ts -> dist/*.js via tsup, add shebang, chmod +x
npm start                    # run the built dist/stdio.js
npm run start:http           # run the built dist/http.js
npm test                     # run the vitest suite (tests/*.test.ts)
npx vitest run tests/write.test.ts   # run a single test file
npx tsc --noEmit             # typecheck only (no lint script configured)
```

## Architecture

- **`src/stdio.ts`** — stdio entrypoint; loads `.env` via `dotenv/config`, starts `server.startStdio()`.
- **`src/http.ts`** — HTTP entrypoint for remote read-only access. Validates a single fixed path (`/mcp`), checks a `Bearer <MCP_HTTP_TOKEN>` header on every request, and otherwise delegates to `remoteServer.startHTTP(...)`. Exits at startup if `MCP_HTTP_TOKEN` is unset — never relax this.
- **`src/server.ts`** — instantiates two `MCPServer` instances from the same tool implementations:
  - `server` — full tool set (read + write), used by stdio.
  - `remoteServer` — the read-only subset only (`readOnlyTools`), used by HTTP. When adding a new tool, decide explicitly whether it belongs in `readOnlyTools` (safe to expose remotely) or is write-capable (stdio-only, alongside `wikiWritePage`/`wikiAppendLog`).
  - Also owns the `instructions` string the MCP client sees (summarizes the INGEST / QUERY / LINT workflows and the read/write boundary between `wiki/` and `raw/`); the HTTP variant appends a note that write tools are unavailable.
- **`src/tools/*.ts`** — one file per MCP tool. Each is a thin `createTool({ id, description, inputSchema (zod), execute })` wrapper with no logic of its own; all real behavior belongs in `src/wiki/service.ts`. Keep this separation when adding tools — don't inline filesystem logic into a tool file.
- **`src/wiki/service.ts`** — all filesystem access:
  - Reads `WIKI_PATH` / `RAW_PATH` env vars at module load (`resolveDir`), defaulting to `./wiki` and `./raw` relative to cwd, resolved to absolute paths.
  - Pages are `.md` files under the wiki dir, parsed with `gray-matter` for YAML frontmatter (`tipo`, `tags`, `fonti`, `aggiornato`, `stato`). Title is extracted from the first `# H1` line, falling back to the filename.
  - Wikilinks (`[[slug]]` / `[[slug|label]]`) are extracted from page content via regex for `wiki_graph`.
  - Writes (`writePage`, `appendLog`) take an inter-process lock via `proper-lockfile` on the target file before writing, to avoid corrupting concurrent writes.
  - `getPage` and `writePage` guard against path traversal by resolving the full path and checking it still starts within the wiki dir; `readRaw` rejects filenames containing `/` or `..`. Preserve these checks in any change — they are the only thing enforcing "agent may write only to `wiki/`, never to `raw/`".
  - Dates derived from file mtime are formatted using `WIKI_TZ` (e.g. `Europe/Rome`) if set, otherwise the host machine's local timezone — relevant when the server runs in a different timezone than its users.
  - `wiki_checksum` computes SHA256 (first 12 hex chars) and checks both wiki and raw dirs when given a relative path.
- **`tests/*.test.ts`** — vitest suite covering write/lock behavior, raw read-only access, graph/status derivation, and search. Point `WIKI_PATH`/`RAW_PATH` at fixture dirs when adding tests rather than mutating the repo's local `wiki/`/`raw/`.

### Tool surface (all defined in `src/tools/`, registered in `src/server.ts`)

| Tool | Backing function | Transport | Notes |
| --- | --- | --- | --- |
| `wiki_search` | `searchPages` | stdio + HTTP | filters by `q`/`tag`/`tipo`/`stato`, returns metadata only (no content/links) |
| `wiki_read_page` | `getPage` | stdio + HTTP | full page incl. frontmatter + content, by slug |
| `wiki_list_pages` | `searchPages` + client-side filter | stdio + HTTP | optional `categoria` = subfolder prefix |
| `wiki_write_page` | `writePage` | stdio only | wiki/ only, `.md` only |
| `wiki_append_log` | `appendLog` | stdio only | appends to `wiki/log.md` |
| `wiki_list_raw` / `wiki_read_raw` | `listRaw` / `readRaw` | stdio + HTTP | read-only access to `raw/` |
| `wiki_checksum` | `fileChecksum` | stdio + HTTP | dedup check for the ingest workflow |
| `wiki_graph` | `getGraph` | stdio + HTTP | slug -> list of linked slugs |
| `wiki_status` | `getStatus` | stdio + HTTP | page counts by `tipo`/`stato`, last-updated date |

## Environment variables

- `WIKI_PATH` / `RAW_PATH` — required in practice; default to `./wiki` / `./raw` relative to cwd if unset.
- `WIKI_TZ` — optional IANA timezone (e.g. `Europe/Rome`) used to format mtime-derived dates consistently regardless of the host machine's local timezone.
- `MCP_HTTP_PORT` — HTTP transport port, default `3000`.
- `MCP_HTTP_TOKEN` — required for `src/http.ts`; process refuses to start without it.

## The wiki content is external and domain-specific

`WIKI_PATH`/`RAW_PATH` in the local `.env` point outside this repo (currently a sibling `llm_wiki/` project). The `wiki/` and `raw/` directories inside this repo are gitignored local fixtures for manual testing only — do not treat their contents as representative of real usage.

The actual content schema/workflow for the target wiki (an Italian traffic-code "verbalizzazione" domain knowledge base — page naming, frontmatter shape, INGEST/QUERY/LINT agent workflows) is documented in `src/docs/CLAUDE.md` in this repo. That file is currently untracked and describes conventions for agents operating on the *wiki content*, not on this server's code — it's effectively the `CLAUDE.md`/`AGENTS.md` meant to live inside the external wiki project directory, not inside `wiki-mcp-api/src/`. Don't confuse its instructions (Italian-language wiki page conventions) with instructions for working on this codebase.
