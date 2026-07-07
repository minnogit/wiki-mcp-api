# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generic MCP (Model Context Protocol) server, built on `@mastra/mcp`, that exposes a markdown-file-based wiki to AI agents over stdio. It is domain-agnostic: the wiki content itself (pages, frontmatter conventions, ingest workflow) lives in an external directory pointed to by env vars, not in this repo. This repo is only the server/tool implementation.

## Commands

```bash
npm install
cp .env.example .env        # set WIKI_PATH / RAW_PATH before running

npm run dev                 # run src/stdio.ts directly via tsx (no build step)
npm run build                # bundle src/stdio.ts -> dist/stdio.js via tsup, add shebang, chmod +x
npm start                    # run the built dist/stdio.js
npx tsc --noEmit             # typecheck only (no dedicated lint/test scripts exist in package.json)
```

There is no test suite and no lint script configured.

## Architecture

- **`src/stdio.ts`** — entrypoint; loads `.env` via `dotenv/config`, starts `server.startStdio()`.
- **`src/server.ts`** — instantiates the `MCPServer`, wires up all tools, and sets the `instructions` string the MCP client sees (summarizes the INGEST / QUERY / LINT workflows and the read/write boundary between `wiki/` and `raw/`).
- **`src/tools/*.ts`** — one file per MCP tool. Each is a thin `createTool({ id, description, inputSchema (zod), execute })` wrapper with no logic of its own; all real behavior belongs in `src/wiki/service.ts`. Keep this separation when adding tools — don't inline filesystem logic into a tool file.
- **`src/wiki/service.ts`** — all filesystem access:
  - Reads `WIKI_PATH` / `RAW_PATH` env vars at module load (`resolveDir`), defaulting to `./wiki` and `./raw` relative to cwd, resolved to absolute paths.
  - Pages are `.md` files under the wiki dir, parsed with `gray-matter` for YAML frontmatter (`tipo`, `tags`, `fonti`, `aggiornato`, `stato`). Title is extracted from the first `# H1` line, falling back to the filename.
  - Wikilinks (`[[slug]]` / `[[slug|label]]`) are extracted from page content via regex for `wiki_graph`.
  - `getPage` and `writePage` guard against path traversal by resolving the full path and checking it still starts with the wiki dir; `readRaw` rejects filenames containing `/` or `..`. Preserve these checks in any change — they are the only thing enforcing "agent may write only to `wiki/`, never to `raw/`".
  - `wiki_checksum` computes SHA256 (first 12 hex chars) and checks both wiki and raw dirs when given a relative path.

### Tool surface (all defined in `src/tools/`, registered in `src/server.ts`)

| Tool | Backing function | Notes |
| --- | --- | --- |
| `wiki_search` | `searchPages` | filters by `q`/`tag`/`tipo`/`stato`, returns metadata only (no content/links) |
| `wiki_read_page` | `getPage` | full page incl. frontmatter + content, by slug |
| `wiki_list_pages` | `searchPages` + client-side filter | optional `categoria` = subfolder prefix |
| `wiki_write_page` | `writePage` | wiki/ only, `.md` only |
| `wiki_append_log` | `appendLog` | appends to `wiki/log.md` |
| `wiki_list_raw` / `wiki_read_raw` | `listRaw` / `readRaw` | read-only access to `raw/` |
| `wiki_checksum` | `fileChecksum` | dedup check for the ingest workflow |
| `wiki_graph` | `getGraph` | slug -> list of linked slugs |
| `wiki_status` | `getStatus` | page counts by `tipo`/`stato`, last-updated date |

## The wiki content is external and domain-specific

`WIKI_PATH`/`RAW_PATH` in the local `.env` point outside this repo (currently a sibling `llm_wiki/` project). The `wiki/` and `raw/` directories inside this repo are gitignored local fixtures for manual testing only — do not treat their contents as representative of real usage.

The actual content schema/workflow for the target wiki (an Italian traffic-code "verbalizzazione" domain knowledge base — page naming, frontmatter shape, INGEST/QUERY/LINT agent workflows) is documented in `src/docs/CLAUDE.md` in this repo. That file is currently untracked and describes conventions for agents operating on the *wiki content*, not on this server's code — it's effectively the `CLAUDE.md`/`AGENTS.md` meant to live inside the external wiki project directory, not inside `wiki-mcp-api/src/`. Don't confuse its instructions (Italian-language wiki page conventions) with instructions for working on this codebase.
