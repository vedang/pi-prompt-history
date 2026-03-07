# Prompt History Extension

A Ctrl-R style prompt-history search extension for pi.

## What it does

This extension indexes prior **user prompts** from pi session JSONL files and lets you
search them with a floating overlay.

If you already have text in the editor, pressing `Ctrl+R` seeds the overlay query with
that text so the history list starts filtered immediately.

### Search scopes

- **Local**: only prompts from sessions whose `cwd` exactly matches the current pi working directory.
- **Global**: prompts from all indexed pi sessions.

## Configuration

Prompt-history behavior is read from three locations, merged in order:

1. `config.json` next to the extension entrypoint (extension defaults)
2. `~/.pi/agent/extensions/prompt-history.json` (global override)
3. `.pi/extensions/prompt-history.json` in the current project (project override)

Supported settings:

- `dbPath` (`string`) – prompt-history sqlite path.
- `sessionDir` (`string`) – session JSONL directory to index.
- `maxResults` (`number`) – number of results returned from search.
- `primaryAction` (`"copy" | "resume"`) – default selection action in overlay.

Example `~/.pi/agent/extensions/prompt-history.json`:

```json
{
  "dbPath": "~/.pi/agent/prompt-history/history.db",
  "sessionDir": "~/.pi/agent/sessions",
  "maxResults": 20,
  "primaryAction": "copy"
}
```

## Commands and shortcuts

- `/prompt-history` — open the prompt-history overlay in Local mode
- `/prompt-history-global` — open the prompt-history overlay in Global mode
- `/prompt-history-reindex` — rebuild the Local index
- `/prompt-history-reindex global` — rebuild the Global index
- `/prompt-history-status` — show indexed prompt/session counts
- `Ctrl+R` — open the prompt-history overlay in Local mode

## Overlay controls

- `↑` / `↓` — move selection
- `PageUp` / `PageDown` — move by page
- `Enter` — primary action (copy by default, resume when `primaryAction` is `"resume"`)
- `F2` — secondary action (resume by default, copy when `primaryAction` is `"resume"`)
- `Esc` — cancel without changing editor contents
- `Tab` — toggle Local/Global mode
- `Ctrl+R` — also toggle Local/Global mode while the overlay is open

### Selection behavior

- **Copy action**: selected prompt text is copied into the editor and the OS clipboard.
- **Resume action**: always prompts a follow-up choice:
  - `Fork from this point (default)`: if needed, prompt-history first resumes the selected session, then forks from the chosen prompt and pre-fills the selected text.
  - `Restore entire session`: switches to the selected entry's session file.

### Session-aware UX

Prompt-history keeps the existing **Local** and **Global** search scopes, but the overlay now groups results into explicit sections:

- **Current session**
- **Same cwd** (other sessions in the current working directory)
- **Other cwd** (sessions from elsewhere)

- In **Local** scope, you typically see **Current session** and **Same cwd**.
- In **Global** scope, **Other cwd** sessions are grouped separately and include their source cwd in the metadata.

This matches Pi's built-in session model more closely: cross-session forking works by resuming the target session first, then forking within that resumed session.

## Storage and indexing

- Session source: `~/.pi/agent/sessions/`
- Prompt-history DB: `~/.pi/agent/prompt-history/history.db`
- Backend: `sqlite3` CLI (widely available, zero npm runtime dependency)

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
