# Prompt History Extension (Scaffold)

This directory contains the initial scaffold for a future Ctrl-R style prompt history
search extension.

## Purpose

- Define a stable module layout for prompt indexing, parsing, search, and selector UI.
- Keep the structure discoverable by `pi` extension loading.
- Keep implementation intentionally out-of-scope for this commit; behavior is added in
  follow-up tasks.

## Planned modules

- `config.ts`: runtime configuration defaults and parsing helpers.
- `db.ts`: database schema + connection helpers.
- `parser.ts`: session file parsing utilities.
- `indexer.ts`: indexing pipelines and incremental update behavior.
- `search.ts`: local/global search query logic.
- `selector.ts`: overlay selector scaffolding.
- `commands.ts`: command/shortcut registration and payload helpers.
- `index.ts`: extension entrypoint.

## Dependency intent

- `fzf`: fuzzy ranking for interactive prompt selection.
- `sqlite` / `sqlite3`: SQLite storage for fast local/global history search.

## Status

This scaffold contains no functional behavior yet. Commands, UI wiring, parsing,
indexing, and ranking are intentionally deferred to later commits.
