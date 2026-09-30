# systemone-mcp-server

MCP server exposing the System One decision tools — [ten-levels-of-jev](https://github.com/paulrobello/ten-levels-of-jev) levels 8–10 as MCP tools for Claude Code (and any MCP client). Code reads the files, System One judges them, and nothing enters the agent's context: one call ≈ 300 ms, fractions of a cent.

## Tools

| Tool | What it does |
|---|---|
| `ask_systemone` | One System One call over an assembled situation: short own state, up to 20 files code reads, and/or one **gated** read-only command's output. Typed answers back (noul / choice / score). |
| `ask_systemone_files` | The same question block over many files — one System One call per file, in parallel (cap 255). Answers per path; oversized/binary files come back in `skipped` with reasons. |
| `pick_first_file` | Second pass after `ask_systemone_files`: which of a candidate list to open first, as a Choice keyed by path. |
| `ask_systemone_file_bool` / `_choice` / `_score` | One file, one typed question each (probability of yes, pick an option, position on a 2–10 level scale). |

Claude Code has no pi hooks here, so `ask_systemone`'s `command` runs through the level 6 bash gate **inside the tool** (irreversible/destructive commands refuse; the gate fails closed after ~5 s) instead of a harness hook. The compaction tools (`should_i_compact` / `compact_now`) from the omp extension do not port — Claude Code exposes no compaction API — and are deliberately absent.

## Backend

Calls default to the local [cc-router](https://github.com/paulrobello/cc-router) relay (`http://127.0.0.1:8792/v1/systemone`): cc-router owns the OpenRouter auth, logging, and stats — no key is needed on this side. Every call emits a `SYSTEMONE_EVENT` JSON line on the server's stderr.

| Variable | Effect |
|---|---|
| *(none set)* | Relay through cc-router. If cc-router is down, calls error — no silent mock. |
| `SYSTEMONE_ENDPOINT` | Relay at this URL instead (same convention as systemone-router). Wins over `OPENROUTER_API_KEY`. |
| `SYSTEMONE_BACKEND` | `mock` (offline, no key) or `openrouter` (direct with the ambient key). Wins over everything. |
| `OPENROUTER_API_KEY` | Direct OpenRouter with this key. |
| `SYSTEMONE_OPENROUTER_KEY` | Bearer for the relay path (default: `~/.config/systemone/key`, else an inert placeholder). |

## Install (Claude Code, user scope)

```bash
claude mcp add -s user systemone-mcp-server -- bun /Users/probello/Repos/systemone-mcp-server/src/index.ts
```

The `ask-systemone` skill (when to prefer which tool, how to write criteria, the `skipped` discipline) lives in `skills/ask-systemone/` — symlink it into `~/.claude/skills/`:

```bash
ln -s /Users/probello/Repos/systemone-mcp-server/skills/ask-systemone ~/.claude/skills/ask-systemone
```

## Develop

```bash
bun install
make checkall   # fmt-check + lint + typecheck + test
make test       # in-memory MCP client over the offline mock backend, no key, no network
```

## Layout

- `src/index.ts` — the server: six tools over the vendored level code.
- `src/systemone.ts` — the decide wrapper: env-resolved client (cc-router relay default), SYSTEMONE_EVENT reporting, guard timeout.
- `src/systemone/` — vendored from ten-levels-of-jev `apps/ten-levels` (commit `2b584a5`): `core/`, `decide.ts`, `levels/level06`–`level10`, with the upstream identifiers, env vars, and prose renamed to System One (model ids and model pricing kept). Do not edit otherwise; to update, re-copy from upstream and reapply that rename. Excluded from biome (vendored formatting).

### TypeScript note

`registerTool`'s generics (ShapeOutput over zod 3.25's dual v3/v4 compat types) exceed TS 5.9's instantiation depth at every call site, so `src/index.ts` erases them behind a small adapter (`register` + `shape`) with `object`-typed schemas. Runtime validation is unchanged: the SDK parses arguments against the zod shape, and the level functions validate their own inputs.

## License

MIT
