import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Database module for prompt history indexing.
 */
export interface PromptHistoryDbConfig {
	path: string;
}

export interface PromptHistoryEntry {
	id: string;
	sessionFile: string;
	text: string;
	cwd: string;
	timestampMs: number;
}

export interface IndexedSessionMetadata {
	sessionFile: string;
	sessionName: string;
	cwd: string;
	indexedMtimeMs: number;
	indexedSizeBytes: number;
	indexedPromptCount: number;
	lastIndexedAtMs: number;
}

export interface ListRecentPromptsOptions {
	scope: "local" | "global";
	cwd: string;
	limit: number;
}

interface SessionRow {
	session_file: string;
	session_name: string | null;
	cwd: string;
	indexed_mtime_ms: number;
	indexed_size_bytes: number;
	indexed_prompt_count: number;
	last_indexed_at_ms: number;
}

interface PromptRow {
	id: string;
	session_file: string;
	text: string;
	cwd: string;
	prompt_timestamp_ms: number;
}

const expandHome = (inputPath: string): string => {
	if (!inputPath.startsWith("~")) {
		return resolve(inputPath);
	}

	return resolve(inputPath.replace(/^~(?=$|\/)/, homedir()));
};

export class PromptHistoryDb {
	private readonly db: DatabaseSync;

	constructor(config: PromptHistoryDbConfig) {
		const resolvedPath = expandHome(config.path);
		const directory = dirname(resolvedPath);
		mkdirSync(directory, { recursive: true });

		this.db = new DatabaseSync(resolvedPath);
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.prepareSchema();
	}

	private prepareSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				session_file TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				session_name TEXT,
				indexed_mtime_ms INTEGER NOT NULL,
				indexed_size_bytes INTEGER NOT NULL,
				indexed_prompt_count INTEGER NOT NULL DEFAULT 0,
				last_indexed_at_ms INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS prompts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				parent_id TEXT,
				cwd TEXT NOT NULL,
				session_name TEXT,
				prompt_timestamp_ms INTEGER NOT NULL,
				ordinal_in_session INTEGER NOT NULL,
				text TEXT NOT NULL,
				preview TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				indexed_at_ms INTEGER NOT NULL,
				FOREIGN KEY(session_file) REFERENCES sessions(session_file) ON DELETE CASCADE,
				UNIQUE(session_file, entry_id)
			);

			CREATE INDEX IF NOT EXISTS prompts_session_time_idx
				ON prompts(session_file, prompt_timestamp_ms DESC, ordinal_in_session DESC);

			CREATE INDEX IF NOT EXISTS prompts_recent_idx
				ON prompts(cwd, prompt_timestamp_ms DESC, ordinal_in_session DESC);
		`);
	}

	close(): void {
		this.db.close();
	}

	getIndexedSession(sessionFile: string): IndexedSessionMetadata | null {
		const row = this.db
			.prepare(
				"SELECT session_file, session_name, cwd, indexed_mtime_ms, indexed_size_bytes, indexed_prompt_count, last_indexed_at_ms FROM sessions WHERE session_file = ?",
			)
			.get(sessionFile) as SessionRow | undefined;

		if (!row) {
			return null;
		}

		return {
			sessionFile: row.session_file,
			sessionName: row.session_name ?? "",
			cwd: row.cwd,
			indexedMtimeMs: row.indexed_mtime_ms,
			indexedSizeBytes: row.indexed_size_bytes,
			indexedPromptCount: row.indexed_prompt_count,
			lastIndexedAtMs: row.last_indexed_at_ms,
		};
	}

	upsertSession(metadata: IndexedSessionMetadata): void {
		this.db
			.prepare(
				"INSERT INTO sessions (session_file, cwd, session_name, indexed_mtime_ms, indexed_size_bytes, indexed_prompt_count, last_indexed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_file) DO UPDATE SET cwd = excluded.cwd, session_name = excluded.session_name, indexed_mtime_ms = excluded.indexed_mtime_ms, indexed_size_bytes = excluded.indexed_size_bytes, indexed_prompt_count = excluded.indexed_prompt_count, last_indexed_at_ms = excluded.last_indexed_at_ms",
			)
			.run(
				metadata.sessionFile,
				metadata.cwd,
				metadata.sessionName,
				metadata.indexedMtimeMs,
				metadata.indexedSizeBytes,
				metadata.indexedPromptCount,
				metadata.lastIndexedAtMs,
			);
	}

	clearSessionPrompts(sessionFile: string): number {
		return this.db
			.prepare("DELETE FROM prompts WHERE session_file = ?")
			.run(sessionFile).changes;
	}

	insertPrompt(
		prompt: {
			sessionFile: string;
			entryId: string;
			parentId: string | null;
			sessionName: string;
			cwd: string;
			promptTimestampMs: number;
			ordinalInSession: number;
			text: string;
			preview: string;
			contentHash: string;
		},
		indexedAtMs: number,
	): number {
		const statement = this.db.prepare(`
			INSERT OR IGNORE INTO prompts (
				session_file,
				entry_id,
				parent_id,
				cwd,
				session_name,
				prompt_timestamp_ms,
				ordinal_in_session,
				text,
				preview,
				content_hash,
				indexed_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		return statement.run(
			prompt.sessionFile,
			prompt.entryId,
			prompt.parentId,
			prompt.cwd,
			prompt.sessionName,
			prompt.promptTimestampMs,
			prompt.ordinalInSession,
			prompt.text,
			prompt.preview,
			prompt.contentHash,
			indexedAtMs,
		).changes;
	}

	listRecentPrompts(options: ListRecentPromptsOptions): PromptHistoryEntry[] {
		const rows =
			options.scope === "global"
				? (this.db
						.prepare(
							"SELECT entry_id AS id, session_file, text, cwd, prompt_timestamp_ms FROM prompts ORDER BY prompt_timestamp_ms DESC, ordinal_in_session DESC LIMIT ?",
						)
						.all(options.limit) as PromptRow[])
				: (this.db
						.prepare(
							"SELECT entry_id AS id, session_file, text, cwd, prompt_timestamp_ms FROM prompts WHERE cwd = ? ORDER BY prompt_timestamp_ms DESC, ordinal_in_session DESC LIMIT ?",
						)
						.all(options.cwd, options.limit) as PromptRow[]);

		return rows.map((row) => ({
			id: row.id,
			sessionFile: row.session_file,
			text: row.text,
			cwd: row.cwd,
			timestampMs: row.prompt_timestamp_ms,
		}));
	}

	getSessionPromptCount(sessionFile: string): number {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS promptCount FROM prompts WHERE session_file = ?",
			)
			.get(sessionFile) as { promptCount: number } | undefined;

		return row?.promptCount ?? 0;
	}
}
