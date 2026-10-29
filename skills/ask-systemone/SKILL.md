---

name: ask-systemone
description: Use when a task needs a judgment about files or code without reading them into context — "ask System One about these files", classifying files, scoring risk or complexity, yes/no with confidence, picking which file to open first, triaging a directory or glob ("which of these files handles billing", "does this file validate tokens", "rank these by refactor risk"). Triggers on ask_systemone, ask_systemone_files, ask_systemone_file_bool/choice/score, pick_first_file, "ask System One" about a file or directory, System One MCP tools. Not for sorting piles of emails, tickets, or pasted text (that is the systemone skill) and not for exact string lookups (grep).
---

# ask-systemone — System One decision tools via MCP

The `systemone-mcp-server` MCP tools ask System One (TypeSafe's typed-question decisions API, via cc-router) typed questions about files and state. Code reads the files; System One judges them; **nothing enters your context**. One call ≈ 300ms, fractions of a cent.

## Which tool

| Need                                                                      | Tool                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Yes/no about one file, with probability                                   | `ask_systemone_file_bool(path, question, yes?, no?)`              |
| Pick one option about one file                                            | `ask_systemone_file_choice(path, question, options)`              |
| Position on a 2–10 level scale (risk, complexity)                         | `ask_systemone_file_score(path, question, levels)`                |
| Same questions over many files (globs, dirs, up to 255)                   | `ask_systemone_files(paths_or_globs, questions_json, recursive?)` |
| Which file to open first after triage                                     | `pick_first_file(question, candidates)`                           |
| One situation: short state + up to 20 files + one gated read-only command | `ask_systemone(questions_json, state?, paths?, command?)`         |

## How to write questions

- Write every question against `content` (the file's text); `path` is also in the state.
- **Criteria decide quality.** Spell out what counts as yes/no, what each option means, what each level of a scale looks like. A criteria-less question gets an honest 0.5.
- Batch: `ask_systemone_files` makes one call per file regardless, so ask every question you might need in one block.
- Three types: `noul` (probability of yes), `choice` (one of your keys + confidence), `score` (position on your levels).

## Rules that prevent bad results

- **Read `skipped` in every `ask_systemone_files` result** and act on it: `too large` files never got judged — narrow them, ask per-file with `paths`, or read them yourself. Acting on results while ignoring `skipped` means judging a subset you think is the whole set.
- Oversized or over-budget inputs are refused with a reason (and, for `ask_systemone`, a suggested split into multiple calls) — never silently truncated. Follow the split instead of pasting content into `state`.
- Use `read` when you need the code itself (to edit or quote); use grep for exact strings. These tools are for judgment, not retrieval.
- `pick_first_file` after `ask_systemone_files`: pass the per-file answers as `note` on each candidate.
- `ask_systemone`'s `command` runs through a bash gate and must be read-only; destructive commands are refused.

## Backend

Calls default to the local cc-router relay (`http://127.0.0.1:8792/v1/systemone`) — no key needed; cc-router owns auth, logging, and stats. If cc-router is down, calls error (no silent mock): start it, or set `SYSTEMONE_BACKEND=mock` for offline use. `SYSTEMONE_ENDPOINT` redirects the relay; `OPENROUTER_API_KEY` goes direct. Every call emits a `SYSTEMONE_EVENT` line on the server's stderr.

Source: [ten-levels-of-jev](https://github.com/paulrobello/ten-levels-of-jev) levels 8–10, served by [systemone-mcp-server](https://github.com/paulrobello/systemone-mcp-server).
