# Prompt History Extension

A Ctrl-R style prompt-history search extension for pi.

## What it does

This extension indexes prior **user prompts** from pi session JSONL files and lets you
search them with a floating overlay.

### Search scopes

- **Local**: only prompts from sessions whose `cwd` exactly matches the current pi working directory.
- **Global**: prompts from all indexed pi sessions.

## Commands and shortcut

- `/prompt-history` — open the prompt-history overlay in Local mode
- `/prompt-history-global` — open the prompt-history overlay in Global mode
- `/prompt-history-reindex` — rebuild the Local index
- `/prompt-history-reindex global` — rebuild the Global index
- `/prompt-history-status` — show indexed prompt/session counts
- `Ctrl+R` — open the prompt-history overlay in Local mode

## Overlay controls

- `↑` / `↓` — move selection
- `PageUp` / `PageDown` — move by page
- `Enter` — load the selected prompt into the editor
- `Esc` — cancel without changing editor contents
- `Tab` — toggle Local/Global mode
- `Ctrl+R` — also toggle Local/Global mode while the overlay is open

## Storage and indexing

- Session source: `~/.pi/agent/sessions/`
- Prompt-history DB: `~/.pi/agent/prompt-history/history.db`
- Backend: built-in `node:sqlite` (zero extra runtime install)

The indexer:
- parses pi session JSONL files
- extracts only `message.role === "user"` prompts
- skips unchanged session files using file size + mtime
- appends new prompts when a session grows
- rebuilds a session index when the file shrinks or when reindex is forced

## Notes

- This extension replaces the editor contents with the selected prompt, matching shell reverse-history search semantics.
- Local mode uses **exact cwd equality** rather than repo-root matching.
- Search uses persistent indexing plus in-process ranking and match highlighting metadata.
