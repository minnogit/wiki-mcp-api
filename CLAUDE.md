# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generic MCP (Model Context Protocol) server, built on `@mastra/mcp`, that exposes a markdown-file-based wiki to AI agents. It is domain-agnostic: the wiki content itself (pages, frontmatter conventions, ingest workflow) lives in an external directory pointed to by env vars, not in this repo. This repo is only the server/tool implementation.

Two transports are exposed from the same tool set, defined in `src/server.ts`:

- **stdio** (`src/stdio.ts`) — local process, full read+write tool set. This is what MCP clients (Claude Code, OpenCode) spawn directly.
- **HTTP** (`src/http.ts`) — remote, **read-only**, Bearer-token authenticated (per-user tokens and/or the legacy single token). Refuses to start without at least one credential source.

One process can serve **several wikis** (`WIKI_CONFIG`): each wiki has its own context (`WikiContext`), its own service (`createWikiService`) and its own `MCPServer`; over HTTP the endpoint `/mcp/<name>` picks the wiki, over stdio `WIKI_NAME` does. Without `WIKI_CONFIG` there is a single wiki named `default`, built from `WIKI_PATH`/`RAW_PATH`/`WIKI_DOMAIN`/`WIKI_TZ`.

## Commands

```bash
npm install
cp .env.example .env        # set WIKI_PATH / RAW_PATH (or WIKI_CONFIG) before running

npm run dev                  # run src/stdio.ts directly via tsx (no build step)
npm run dev:http             # run src/http.ts directly via tsx
npm run build                # bundle stdio.ts & http.ts -> dist/*.js via tsup, add shebang, chmod +x
npm start                    # run the built dist/stdio.js
npm run start:http           # run the built dist/http.js
npm test                     # run the vitest suite (tests/*.test.ts)
npx vitest run tests/write.test.ts   # run a single test file
npm run lint                 # eslint (typescript-eslint, type-aware) + tsc typecheck of src/ and tests/
npm run format               # format src/ and tests/ with prettier (.prettierrc)
npm run format:check         # verify formatting without writing
```

## Architecture

- **`src/config.ts`** — configuration: `loadWikis(env)` returns the list of `WikiContext`. Without `WIKI_CONFIG` it returns one wiki named `default` from `WIKI_PATH`/`RAW_PATH`/`WIKI_DOMAIN`/`WIKI_TZ` (exactly the historical behaviour: `./wiki` and `./raw` defaults, empty values ignored). With `WIKI_CONFIG=/path/wikis.json` it reads a JSON array validated with zod (`parseWikiConfig`): `name` `[a-z0-9-]` and unique, `wikiPath` required, `rawPath`/`domain`/`tz` optional, unknown fields rejected; relative paths are resolved against the config file's directory, not the cwd, and the four env vars above are ignored. Errors are `ConfigError`s with a message meant to be printed at startup. `selectWiki(wikis, WIKI_NAME)` is the stdio choice (name required if more than one wiki).
- **`src/stdio.ts`** — stdio entrypoint; loads `.env` via `dotenv/config`, picks one wiki (`selectWiki`), starts `buildServer(createWikiService(ctx)).startStdio()`. One wiki per process.
- **`src/http.ts`** — HTTP entrypoint for remote read-only access. Loads all wikis, builds **one `MCPServer` per wiki once at startup** (never per request), wires config (port, host, token) to the handler and delegates MCP requests to `servers.get(wiki).startHTTP(...)`. Listens on `MCP_HTTP_HOST` (default `127.0.0.1`, not all interfaces). Exits at startup if there is no credential (neither `MCP_HTTP_TOKENS_FILE` nor `MCP_HTTP_TOKEN`), the token file is invalid, or the wiki configuration is invalid — never relax this. Runs each MCP request inside `runWithPrincipal`.
- **`src/http-auth.ts`** — request handling logic for `http.ts`, kept separate so it is testable without starting the MCP server: unauthenticated `GET /healthz` (`{status:"ok"}`, evaluated before the token check, never touches the MCP server; other tooling such as Docker healthchecks relies on this exact path and contract), routing of `/mcp/<name>` and the `/mcp` alias, Bearer token extraction + authentication through an `Authenticator` (`auth` option; `token: 'x'` is a shorthand for the legacy-only authenticator, kept so older call sites and tests work), and an in-memory per-IP rate limiter on failed auth (429 + `Retry-After`). **Order matters**: health -> path shape (404 for anything that is not `/mcp` or `/mcp/<one-segment>`) -> rate limit -> token (401: unknown, revoked or expired, all counted by the rate limiter) -> wiki resolution (404 for an unknown name, for a wiki not enabled for the principal, and for `/mcp` when more than one wiki is configured; the alias works only with exactly one wiki; these cases must stay byte-identical). Resolving the wiki *after* authentication is deliberate: without a valid token nobody can tell which wikis exist or whether there are several, and the 404 body never lists names. `mcp(wiki, url, req, res, principal)` receives the authenticated `Principal`. Covered by `tests/http-auth.test.ts` and `tests/http-routing.test.ts` (which also runs real `MCPServer`s end to end).
- **`src/auth.ts`** — identity. `Principal = { id, user, groups, wikis: string[] | '*' }`, `runWithPrincipal(principal, fn)` / `currentPrincipal()` on an `AsyncLocalStorage`, `createAuthenticator` (sha256 of the presented token compared with `timingSafeEqual` against **every** entry, no early exit; expiry checked after the comparison), `createAuthFromEnv` (startup policy: legacy token and/or token file, error if neither, warning if legacy only), `LEGACY_PRINCIPAL` (`{id:'legacy', user:'legacy', groups:[], wikis:'*'}`).
- **`src/token-file.ts`** — the token file: zod schema (`.strict()`, unique ids and hashes, `sha256:<hex>` only — never plaintext tokens), `TokenFileStore` (hot reload on inode/size/mtime change with a `stat` at most every 2 s; after startup an invalid or missing file keeps the last valid version and logs once — never opens access, never closes it for a typo), `writeTokenFile` (atomic temp+rename, keeps mode/owner of the existing file, new files are 0600).
- **`src/cli/token.ts`** — `npm run token -- create|list|revoke` (dev, tsx) / `node dist/cli/token.js` (built). The plaintext token is printed once on stdout by `create`; messages go to stderr; never log a token.
- **`src/server.ts`** — builders, one `MCPServer` per call, from the wiki's service (`svc.context` carries name/domain/rawDir):
  - `buildServer(svc)` — full tool set (read + write), used by stdio.
  - `buildRemoteServer(svc, { exposeRaw })` — used by HTTP. By default only the page-reading tools (`wikiReadTools`: `wikiSearch`, `wikiReadPage`, `wikiListPages`, `wikiGraph`, `wikiStatus`); the source tools (`sourceTools`: `wikiListRaw`, `wikiReadRaw`, `wikiRawDiff`, `wikiChecksum`) are mounted only when `exposeRaw` is true (default: `rawOverHttp()`, i.e. `MCP_HTTP_EXPOSE_RAW=true`), because over HTTP they expose everything in the wiki's raw dir and its git history. `wikiChecksum` counts as a source tool: it also checks `raw/`. A wiki without `rawDir` never mounts the source tools, on any transport. When adding a new tool, decide explicitly whether it belongs in the read tools (safe to expose remotely), the source tools, or the write tools (stdio-only, alongside `wikiWritePage`/`wikiAppendLog`).
  - Also owns the `instructions` string the MCP client sees (summarizes the INGEST / QUERY / LINT workflows and the read/write boundary between `wiki/` and `raw/`); the HTTP variant appends a note that write tools are unavailable. The opening domain line comes from the context's `domain` — keep it configurable, never hardcode a specific wiki's domain here.
  - The exposed MCP tool name is the **key** in the tools object, not the tool's own `id` field. Keep the two identical (both camelCase) when adding a tool: they diverged once, and every doc plus the `instructions` string ended up advertising snake_case names that no client could call. Tools do **not** take a `wiki` parameter: the endpoint picks the wiki.
  - Server `id`/`name` stay as before for the `default` wiki; other wikis get `-<name>` / ` [<name>]` appended.
- **`src/tools/*.ts`** — one file per MCP tool. Each exports a **factory** `(svc: WikiService) => createTool({ id, description, inputSchema (zod), execute })`: a thin wrapper with no logic of its own that calls only the service it was given; all real behavior belongs in `src/wiki/service.ts`. Keep this separation when adding tools — don't inline filesystem logic into a tool file, and don't import service functions at module level (there is no global service).
- **`src/wiki/service.ts`** — all filesystem access, via `createWikiService(ctx: WikiContext)`, which returns `{ context, getAllPages, getPage, searchPages, writePage, appendLog, listRaw, readRaw, rawDiff, fileChecksum, getGraph, getStatus }` bound to that context (`WikiService`). **No module-level state**: dirs, timezone and the page parsing cache live in the closure, so two services in one process share nothing (tests in `tests/multi-wiki.test.ts`). Pure helpers (link extraction, frontmatter validation, `scanDir`, `checksumIn`, ...) stay at module level.
  - A `WikiContext` is `{ name, wikiDir, rawDir?, domain?, tz? }`; the service does no env reading. `rawDir` absent means the source functions throw `Sorgenti raw non configurate…` and `fileChecksum` only looks in the wiki dir.
  - Pages are `.md` files under the wiki dir, parsed with `gray-matter` for YAML frontmatter (`tipo`, `tags`, `fonti`, `aggiornato`, `stato`). Title is extracted from the first `# H1` line, falling back to the filename.
  - Wikilinks (`[[slug]]` / `[[slug|label]]`) and relative markdown links to `.md` pages (`[x](a.md)`, `[x](/dir/a.md#sec)`, the OKF convention) are extracted via regex and normalized to slugs for `wikiGraph`; external URLs, non-`.md` targets and paths escaping the wiki dir are ignored.
  - Writes (`writePage`, `appendLog`) take an inter-process lock via `proper-lockfile` on the target file before writing, to avoid corrupting concurrent writes.
  - `getPage` and `writePage` guard against path traversal by resolving the full path and checking it still starts within the wiki dir (`wikiDir + path.sep`, so a sibling `wiki2` is not reachable); `readRaw`/`rawDiff` reject absolute filenames and ones resolving outside the raw dir. Preserve these checks in any change — they are the only thing enforcing "agent may write only to `wiki/`, never to `raw/`" and "a wiki cannot reach another wiki's files".
  - Dates derived from file mtime are formatted using the context's `tz` (e.g. `Europe/Rome`) if set, otherwise the host machine's local timezone — relevant when the server runs in a different timezone than its users.
  - `wikiChecksum` computes SHA256 (first 12 hex chars) and checks both wiki and raw dirs when given a relative path.
- **`tests/*.test.ts`** — vitest suite covering write/lock behavior, raw read-only access, graph/status derivation, and search. Build services from temp dirs with `setupService`/`makeService` in `tests/helpers.ts` (no env vars, no module reset) rather than mutating the repo's local `wiki/`/`raw/`.

### Tool surface (all defined in `src/tools/`, registered in `src/server.ts`)

The same tool set is exposed per wiki (see the multi-wiki note above); "HTTP" in the table means `/mcp/<name>`.

| Tool | Backing function | Transport | Notes |
| --- | --- | --- | --- |
| `wikiSearch` | `searchPages` | stdio + HTTP | filters by `q`/`tag`/`tipo`/`stato`, returns metadata only (no content/links) |
| `wikiReadPage` | `getPage` | stdio + HTTP | full page incl. frontmatter + content, by slug |
| `wikiListPages` | `searchPages` + client-side filter | stdio + HTTP | optional `categoria` = subfolder prefix |
| `wikiWritePage` | `writePage` | stdio only | wiki/ only, `.md` only |
| `wikiAppendLog` | `appendLog` | stdio only | appends to `wiki/log.md` |
| `wikiListRaw` / `wikiReadRaw` | `listRaw` / `readRaw` | stdio (+ HTTP only with `MCP_HTTP_EXPOSE_RAW=true` and a `rawDir`) | read-only access to `raw/` |
| `wikiRawDiff` | `rawDiff` | stdio (+ HTTP only with `MCP_HTTP_EXPOSE_RAW=true` and a `rawDir`) | git diff di un file di `raw/` rispetto alla versione col checksum registrato in `sources.md` (`sinceChecksum`); richiede `raw/` versionato in git, esegue `git` via `execFile` |
| `wikiChecksum` | `fileChecksum` | stdio (+ HTTP only with `MCP_HTTP_EXPOSE_RAW=true` and a `rawDir`) | dedup check for the ingest workflow; also checks `raw/`, so it is gated like the source tools |
| `wikiGraph` | `getGraph` | stdio + HTTP | slug -> list of linked slugs |
| `wikiStatus` | `getStatus` | stdio + HTTP | page counts by `tipo`/`stato`, last-updated date; optional `source` (short SHA + ISO date of HEAD, last-sync time from `FETCH_HEAD` mtime) from `src/wiki/freshness.ts`, absent when the wiki dir is not in a git repo |

### Principal contract (read this before adding a tool)

- On HTTP, every tool execution runs inside `runWithPrincipal(principal, ...)`, so `currentPrincipal()` returns the identity of **that request** (not of the request that opened the MCP session: a session id can be reused with another valid token, and the tool sees the token actually presented). Propagation through `@mastra/mcp`'s `startHTTP`, session and tool handler is verified end to end in `tests/principal-propagation.test.ts`; if a library upgrade breaks it, that test fails.
- On stdio there is no remote caller: `currentPrincipal()` is `undefined`, meaning **local, full trust**. Never treat `undefined` as "anonymous, deny": future permission checks must allow it and apply only when a principal is present.
- Tools and services read the identity with `currentPrincipal()`; they do not take it as a tool argument (an agent must not be able to claim another user) and the service stays context-bound, not principal-bound. Read it at the point of use, inside `execute`/service calls; do not capture it at module load or in a closure created at startup (the servers are built once, per wiki).
- Auth is Bearer only. OAuth/SSO, if added, must produce the same `Principal`.

## Environment variables

- `WIKI_CONFIG` — optional path to a JSON file listing several wikis (see `src/config.ts`). When set, `WIKI_PATH`, `RAW_PATH`, `WIKI_DOMAIN`, `WIKI_TZ` are ignored. When unset, one wiki named `default` is built from those variables (full backwards compatibility).
- `WIKI_NAME` — stdio only: which wiki of `WIKI_CONFIG` to serve; required when the config lists more than one.
- `WIKI_PATH` / `RAW_PATH` — single-wiki mode only; default to `./wiki` / `./raw` relative to cwd if unset.
- `WIKI_DOMAIN` — single-wiki mode; one line stating which domain the connected wiki documents; injected at the top of the `instructions` string the MCP client receives. In multi-wiki mode it is the `domain` field of each entry. A hardcoded domain line would describe the wrong wiki for all but one of them. Falls back to a neutral sentence pointing at the connected wiki's own `CLAUDE.md`.
- `MCP_HTTP_EXPOSE_RAW` — read by `buildRemoteServer` (via `rawOverHttp()`) when the servers are built. Exactly `true` mounts the source tools on the HTTP servers of wikis that have a `rawDir`; anything else (including `1` or `TRUE`) leaves them out. Covered by `tests/remote-tools.test.ts`.
- `WIKI_TZ` — single-wiki mode; optional IANA timezone (e.g. `Europe/Rome`) used to format mtime-derived dates consistently regardless of the host machine's local timezone. In multi-wiki mode it is the `tz` field.
- `MCP_HTTP_PORT` — HTTP transport port, default `3000`.
- `MCP_HTTP_HOST` — HTTP bind address, default `127.0.0.1` (loopback only). Set `0.0.0.0` to listen on all interfaces (e.g. in a container).
- `MCP_HTTP_RATE_LIMIT_MAX` / `MCP_HTTP_RATE_LIMIT_WINDOW_SECONDS` — failed-auth rate limit per IP, defaults `10` / `60`. Invalid values fall back to the defaults.
- `MCP_HTTP_TOKENS_FILE` — path of the per-user token file (see `src/token-file.ts`). Hot-reloaded. `wikis` entries must exist in the wiki config unless `"*"`.
- `MCP_HTTP_TOKEN` — legacy single token (principal `legacy`, all wikis). At least one of `MCP_HTTP_TOKENS_FILE` / `MCP_HTTP_TOKEN` is required by `src/http.ts`; both can be set. With only the legacy token a startup warning recommends per-user tokens.

## The wiki content is external and domain-specific

`WIKI_PATH`/`RAW_PATH` (or the entries of `WIKI_CONFIG`) in the local `.env` point outside this repo (currently a sibling `llm_wiki/` project). The `wiki/` and `raw/` directories inside this repo are gitignored local fixtures for manual testing only — do not treat their contents as representative of real usage.

`src/docs/CLAUDE.md` in this repo is the **template** for that external file: a domain-agnostic starting point (page naming, frontmatter shape, INGEST/QUERY/LINT agent workflows) meant to be copied next to a wiki's `wiki/` directory and filled in per domain. It describes conventions for agents operating on the *wiki content*, not on this server's code — it's effectively the `CLAUDE.md`/`AGENTS.md` meant to live inside the external wiki project directory, not inside `wiki-mcp-api/src/`. Don't confuse its instructions (Italian-language wiki page conventions) with instructions for working on this codebase.
