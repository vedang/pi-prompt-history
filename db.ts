import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { expandHomePath } from "./config";
import type { SearchScope } from "./search";

/**
 * Database module for prompt history indexing.
 */
export interface PromptHistoryDbConfig {
	path: string;
}

export interface PromptHistoryEntry {
	id: string;
	sessionFile: string;
	sessionName: string;
	preview: string;
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

export interface InsertablePromptHistoryEntry {
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
}

export interface PromptHistoryStats {
	sessionCount: number;
	promptCount: number;
}

export interface ListRecentPromptsOptions {
	// [tag:prompt_history_local_scope_exact_cwd] Local prompt history intentionally uses exact cwd equality.
	scope: SearchScope;
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
	session_name: string | null;
	preview: string;
	text: string;
	cwd: string;
	prompt_timestamp_ms: number;
}

const toSqlValue = (value: number | string | null): string => {
	if (value === null) {
		return "NULL";
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? `${value}` : "NULL";
	}
	return `'${value.replaceAll("'", "''")}'`;
};

const mapPromptRow = (row: PromptRow): PromptHistoryEntry => ({
	id: row.id,
	sessionFile: row.session_file,
	sessionName: row.session_name ?? "",
	preview: row.preview,
	text: row.text,
	cwd: row.cwd,
	timestampMs: row.prompt_timestamp_ms,
});

export class PromptHistoryDb {
	private readonly dbPath: string;

	constructor(config: PromptHistoryDbConfig) {
		this.dbPath = expandHomePath(config.path);
		mkdirSync(dirname(this.dbPath), { recursive: true });
		this.prepareSchema();
	}

	close(): void {
		// sqlite3 CLI invocations are one-shot, so there is no persistent connection to close.
	}

	getIndexedSession(sessionFile: string): IndexedSessionMetadata | null {
		const row = this.queryOne<SessionRow>(
			`SELECT session_file, session_name, cwd, indexed_mtime_ms, indexed_size_bytes, indexed_prompt_count, last_indexed_at_ms FROM sessions WHERE session_file = ${toSqlValue(sessionFile)}`,
		);
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
		this.exec(
			`INSERT INTO sessions (session_file, cwd, session_name, indexed_mtime_ms, indexed_size_bytes, indexed_prompt_count, last_indexed_at_ms)
			 VALUES (${toSqlValue(metadata.sessionFile)}, ${toSqlValue(metadata.cwd)}, ${toSqlValue(metadata.sessionName)}, ${toSqlValue(metadata.indexedMtimeMs)}, ${toSqlValue(metadata.indexedSizeBytes)}, ${toSqlValue(metadata.indexedPromptCount)}, ${toSqlValue(metadata.lastIndexedAtMs)})
			 ON CONFLICT(session_file) DO UPDATE SET
			   cwd = excluded.cwd,
			   session_name = excluded.session_name,
			   indexed_mtime_ms = excluded.indexed_mtime_ms,
			   indexed_size_bytes = excluded.indexed_size_bytes,
			   indexed_prompt_count = excluded.indexed_prompt_count,
			   last_indexed_at_ms = excluded.last_indexed_at_ms;`,
		);
	}

	clearSessionPrompts(sessionFile: string): number {
		const row = this.queryOne<{ changes: number }>(
			`DELETE FROM prompts WHERE session_file = ${toSqlValue(sessionFile)};
			 SELECT changes() AS changes;`,
		);
		return row?.changes ?? 0;
	}

	insertPrompts(
		prompts: InsertablePromptHistoryEntry[],
		indexedAtMs: number,
	): number {
		if (prompts.length === 0) {
			return 0;
		}

		const statements = prompts.map((prompt) => {
			return `INSERT OR IGNORE INTO prompts (
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
			) VALUES (
				${toSqlValue(prompt.sessionFile)},
				${toSqlValue(prompt.entryId)},
				${toSqlValue(prompt.parentId)},
				${toSqlValue(prompt.cwd)},
				${toSqlValue(prompt.sessionName)},
				${toSqlValue(prompt.promptTimestampMs)},
				${toSqlValue(prompt.ordinalInSession)},
				${toSqlValue(prompt.text)},
				${toSqlValue(prompt.preview)},
				${toSqlValue(prompt.contentHash)},
				${toSqlValue(indexedAtMs)}
			);`;
		});

		const row = this.queryOne<{ changes: number }>(
			`BEGIN;
			 ${statements.join("\n")}
			 SELECT total_changes() AS changes;
			 COMMIT;`,
		);
		return row?.changes ?? 0;
	}

	listRecentPrompts(options: ListRecentPromptsOptions): PromptHistoryEntry[] {
		const sql =
			options.scope === "global"
				? `SELECT entry_id AS id, session_file, session_name, preview, text, cwd, prompt_timestamp_ms FROM prompts ORDER BY prompt_timestamp_ms DESC, ordinal_in_session DESC LIMIT ${toSqlValue(options.limit)}`
				: `SELECT entry_id AS id, session_file, session_name, preview, text, cwd, prompt_timestamp_ms FROM prompts WHERE cwd = ${toSqlValue(options.cwd)} ORDER BY prompt_timestamp_ms DESC, ordinal_in_session DESC LIMIT ${toSqlValue(options.limit)}`;

		return this.queryAll<PromptRow>(sql).map(mapPromptRow);
	}

	getStats(options: { scope: SearchScope; cwd: string }): PromptHistoryStats {
		const promptRow =
			options.scope === "global"
				? this.queryOne<{ promptCount: number }>(
						"SELECT COUNT(*) AS promptCount FROM prompts",
					)
				: this.queryOne<{ promptCount: number }>(
						// [ref:prompt_history_local_scope_exact_cwd]
						`SELECT COUNT(*) AS promptCount FROM prompts WHERE cwd = ${toSqlValue(options.cwd)}`,
					);
		const sessionRow =
			options.scope === "global"
				? this.queryOne<{ sessionCount: number }>(
						"SELECT COUNT(*) AS sessionCount FROM sessions",
					)
				: this.queryOne<{ sessionCount: number }>(
						// [ref:prompt_history_local_scope_exact_cwd]
						`SELECT COUNT(*) AS sessionCount FROM sessions WHERE cwd = ${toSqlValue(options.cwd)}`,
					);

		return {
			promptCount: promptRow?.promptCount ?? 0,
			sessionCount: sessionRow?.sessionCount ?? 0,
		};
	}

	getSessionPromptCount(sessionFile: string): number {
		const row = this.queryOne<{ promptCount: number }>(
			`SELECT COUNT(*) AS promptCount FROM prompts WHERE session_file = ${toSqlValue(sessionFile)}`,
		);
		return row?.promptCount ?? 0;
	}

	private prepareSchema(): void {
		this.exec(`
			PRAGMA foreign_keys = ON;
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

			CREATE INDEX IF NOT EXISTS prompts_recent_idx
				ON prompts(cwd, prompt_timestamp_ms DESC, ordinal_in_session DESC);

			CREATE INDEX IF NOT EXISTS prompts_global_recent_idx
				ON prompts(prompt_timestamp_ms DESC, ordinal_in_session DESC);
		`);
	}

	private exec(sql: string): void {
		execFileSync("sqlite3", [this.dbPath, sql], { encoding: "utf8" });
	}

	private queryAll<T>(sql: string): T[] {
		const output = execFileSync("sqlite3", ["-json", this.dbPath, sql], {
			encoding: "utf8",
		}).trim();
		if (!output) {
			return [];
		}
		return JSON.parse(output) as T[];
	}

	private queryOne<T>(sql: string): T | undefined {
		return this.queryAll<T>(sql)[0];
	}
}
